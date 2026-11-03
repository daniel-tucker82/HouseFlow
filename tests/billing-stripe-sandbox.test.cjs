/* eslint-disable @typescript-eslint/no-require-imports -- Opt-in integration test uses real Stripe test mode and isolated PostgreSQL. */
const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const {randomUUID} = require('node:crypto')
const {buildSync} = require('esbuild')
const {Pool} = require('pg')
const Stripe = require('stripe')

function load(relative) {
  const filename = path.resolve(__dirname, '..', relative)
  const compiled = buildSync({entryPoints:[filename],bundle:true,platform:'node',format:'cjs',write:false,
    external:['pg','stripe','next/server','@clerk/nextjs/server']})
  const loaded = new Module(filename,module)
  loaded.paths = module.paths
  const original = loaded.require.bind(loaded)
  loaded.require = id => id === '@clerk/nextjs/server' ? {
    clerkClient:async()=>{throw Error('Sandbox fixture must not request real authentication identities')},
  } : original(id)
  loaded._compile(compiled.outputFiles[0].text,filename)
  return loaded.exports
}

test('real Stripe test-mode billing reconciles into isolated PostgreSQL', {
  skip:process.env.CYNTCH_STRIPE_SANDBOX_TEST !== 'true',timeout:120000,
}, async t => {
  assert.match(process.env.STRIPE_SECRET_KEY ?? '',/^[rs]k_test_/,'Never run financial tests with live credentials')
  const url = new URL(process.env.CYNTCH_TEST_DATABASE_URL)
  assert.equal(url.hostname,'localhost')
  assert.match(url.pathname,/^\/cyntch_billing_test_/)
  process.env.POSTGRES_URL = url.toString()
  process.env.FREEMIUM_ENFORCEMENT_ENABLED = 'true'
  const pool = new Pool({connectionString:url.toString()})
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY,{timeout:15000,maxNetworkRetries:1})
  const subscriptions = []
  for(const file of fs.readdirSync(path.resolve(__dirname,'../database')).filter(f=>f.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.resolve(__dirname,'../database',file),'utf8'))
  }
  const {reconcileHouseholdSubscription,validatedPrice} = load('lib/stripe-billing.ts')
  const {getHouseholdEntitlement} = load('lib/entitlements.ts')
  async function entitlement(household) {
    const client = await pool.connect()
    try{return await getHouseholdEntitlement(client,household)}finally{client.release()}
  }
  async function fixture(source) {
    const household = randomUUID(), user = 'stripe-sandbox-'+household
    await pool.query('insert into users(id,email) values($1,$2)',[user,user+'@example.invalid'])
    await pool.query("insert into households(id,name,leader_id) values($1,'Stripe sandbox fixture',$2)",[household,user])
    await pool.query("insert into household_members(household_id,user_id,role) values($1,$2,'manager')",[household,user])
    const customer = await stripe.customers.create({name:'Cyntch automated sandbox fixture',...(source?{source}:{}),metadata:{application:'cyntch-preview',household_id:household}})
    assert.equal(customer.livemode,false)
    await pool.query('insert into household_billing(household_id,stripe_customer_id) values($1,$2)',[household,customer.id])
    return {household,customer}
  }
  try {
    await t.test('real configured prices match AUD monthly and annual plans',async()=>{
      for(const interval of ['monthly','yearly']) assert.equal((await validatedPrice(interval)).livemode,false)
    })
    const paid = await fixture('tok_visa')
    const sub = await stripe.subscriptions.create({customer:paid.customer.id,items:[{price:process.env.STRIPE_MONTHLY_PRICE_ID}],metadata:{household_id:paid.household},payment_behavior:'error_if_incomplete'})
    subscriptions.push(sub.id)
    await t.test('successful test payment grants household Premium',async()=>{
      assert.equal(sub.status,'active')
      await reconcileHouseholdSubscription(paid.household)
      assert.equal((await entitlement(paid.household)).tier,'premium')
      const row = (await pool.query('select paid_through from household_billing where household_id=$1',[paid.household])).rows[0]
      assert.ok(new Date(row.paid_through).getTime()>Date.now())
    })
    await t.test('period-end cancellation preserves access and can be reactivated',async()=>{
      await stripe.subscriptions.update(sub.id,{cancel_at_period_end:true})
      await reconcileHouseholdSubscription(paid.household)
      assert.equal((await entitlement(paid.household)).tier,'premium')
      assert.equal((await pool.query('select cancel_at_period_end from household_billing where household_id=$1',[paid.household])).rows[0].cancel_at_period_end,true)
      await stripe.subscriptions.update(sub.id,{cancel_at_period_end:false})
      await reconcileHouseholdSubscription(paid.household)
      assert.equal((await pool.query('select cancel_at_period_end from household_billing where household_id=$1',[paid.household])).rows[0].cancel_at_period_end,false)
    })
    await t.test('unpaid incomplete subscription never grants Premium',async()=>{
      const unpaid = await fixture()
      const incomplete = await stripe.subscriptions.create({customer:unpaid.customer.id,items:[{price:process.env.STRIPE_MONTHLY_PRICE_ID}],metadata:{household_id:unpaid.household},payment_behavior:'default_incomplete'})
      subscriptions.push(incomplete.id)
      assert.equal(incomplete.status,'incomplete')
      await reconcileHouseholdSubscription(unpaid.household)
      assert.equal((await entitlement(unpaid.household)).tier,'free')
    })
    await t.test('a declined test payment never grants Premium',async()=>{
      const declined = await fixture('tok_chargeCustomerFail')
      const failed = await stripe.subscriptions.create({customer:declined.customer.id,items:[{price:process.env.STRIPE_MONTHLY_PRICE_ID}],metadata:{household_id:declined.household},payment_behavior:'allow_incomplete'})
      subscriptions.push(failed.id)
      assert.equal(failed.status,'incomplete')
      await reconcileHouseholdSubscription(declined.household)
      assert.equal((await entitlement(declined.household)).tier,'free')
      const invoice = await stripe.invoices.retrieve(failed.latest_invoice)
      assert.equal(invoice.status,'open')
      assert.equal(invoice.amount_paid,0)
    })
    await t.test('real hosted Checkout and portal sessions can be created',async()=>{
      const checkout = await stripe.checkout.sessions.create({mode:'subscription',customer:paid.customer.id,line_items:[{price:process.env.STRIPE_YEARLY_PRICE_ID,quantity:1}],success_url:'https://www.cyntch.com/settings/billing',cancel_url:'https://www.cyntch.com/settings/billing',metadata:{household_id:paid.household},subscription_data:{metadata:{household_id:paid.household}}})
      assert.equal(checkout.livemode,false)
      assert.equal(new URL(checkout.url).hostname,'checkout.stripe.com')
      await stripe.checkout.sessions.expire(checkout.id)
      const portal = await stripe.billingPortal.sessions.create({customer:paid.customer.id,return_url:'https://www.cyntch.com/settings/billing'})
      assert.equal(new URL(portal.url).hostname,'billing.stripe.com')
    })
  } finally {
    for(const id of subscriptions) await stripe.subscriptions.cancel(id).catch(()=>{})
    await pool.end()
    await global.__houseflowPool?.end()
  }
})
