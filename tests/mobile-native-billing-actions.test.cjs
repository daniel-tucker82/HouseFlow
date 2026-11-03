/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL/API flows with synthetic store transports. */
const { test } = require('node:test'), assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { buildSync } = require('esbuild'), { Pool } = require('pg')
const root = path.resolve(__dirname, '..'), connectionString = process.env.CYNTCH_TEST_DATABASE_URL
function load(files, mocks) {
  const loaded = new Module(__filename, module)
  loaded.require = name => mocks[name] ?? require(name)
  loaded._compile(buildSync({ stdin: { contents: files.map(file => `export * from ${JSON.stringify(path.join(root, file))}`).join(';'), resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: Object.keys(mocks) }).outputFiles[0].text, __filename)
  return loaded.exports
}
const products = ['app_store', 'play_store'].flatMap(store => ['monthly', 'yearly'].map(interval => ({
  revenuecatProductId: `${store}_${interval}`, storeProductId: `cyntch.${store}.${interval}`, store, interval,
})))

test('native web cancellation accepts only scoped Stripe session URLs and return pages cannot grant access', async t => {
  const { MobileApi, GET } = load(['mobile/src/services/api.ts','app/mobile/billing/return/route.ts'],{})
  const scope={accountId:'parent',sessionId:'session',householdId:randomUUID(),deviceId:randomUUID()}
  const api=new MobileApi('https://cyntch.test',scope.accountId,scope.deviceId,async()=>'fixture-token',undefined,scope.sessionId)
  const previousFetch=global.fetch;t.after(()=>{global.fetch=previousFetch})
  let response={...scope,provider:'stripe',url:'https://billing.stripe.com/p/session/test_fixture'}
  global.fetch=async()=>Response.json(response)
  assert.equal((await api.webBillingCancellation(scope.householdId)).url,response.url)
  response.url='https://billing.stripe.com/p/session/flow?secret=fixture_opaque-token'
  assert.equal((await api.webBillingCancellation(scope.householdId)).url,response.url)
  for(const url of ['http://billing.stripe.com/p/session/a','https://billing.stripe.com.evil.test/p/session/a','https://billing.stripe.com@evil.test/p/session/a',
    'https://user:secret@billing.stripe.com/p/session/a','https://billing.stripe.com:444/p/session/a','https://billing.stripe.com/p/login/a',
    'https://billing.stripe.com/p/session/a?redirect=bad','https://billing.stripe.com/p/session/a#bad','cyntch://settings',
    'https://billing.stripe.com/p/session/flow','https://billing.stripe.com/p/session/flow?secret=',
    'https://billing.stripe.com/p/session/flow?secret=a&secret=b','https://billing.stripe.com/p/session/flow?secret=a&return_url=bad',
    'https://billing.stripe.com/p/session/flow?secret=https%3A%2F%2Fevil.test']) {
    response={...scope,provider:'stripe',url};await assert.rejects(api.webBillingCancellation(scope.householdId),/invalid cancellation link/)
  }
  response={...scope,provider:'stripe',url:'https://billing.stripe.com/p/session/test_fixture',sessionId:'another'}
  await assert.rejects(api.webBillingCancellation(scope.householdId),/different account/)
  const page=GET(new Request('https://cyntch.test/mobile/billing/return?success=true&return_url=https://evil.test'))
  const html=await page.text()
  assert.equal(page.headers.get('Cache-Control'),'no-store');assert.equal(page.headers.get('Referrer-Policy'),'no-referrer')
  assert.match(page.headers.get('Content-Security-Policy'),/default-src 'none'/)
  assert.equal((html.match(/href=/g)||[]).length,1);assert.match(html,/href="cyntch:\/\/settings"/)
  assert.doesNotMatch(html,/evil.test|success=true|<script|<form/)
})

test('native website cancellation creates only a verified cancellation flow outside household writes', {skip:!connectionString}, async t=>{
  const f=await fixture(t), scope=await f.household()
  await f.db.query(`insert into household_billing(household_id,stripe_customer_id,stripe_subscription_id,subscription_status,paid_through)
    values($1,'cus_cancel','sub_cancel','active',now()+interval '1 month')`,[scope.householdId])
  let subscription={id:'sub_cancel',customer:'cus_cancel',livemode:false,metadata:{household_id:scope.householdId},status:'active',cancel_at:null,cancel_at_period_end:false,
    items:{has_more:false,data:[{price:{id:'price_monthly'},quantity:1}]}}
  const configuration={id:'bpc_mobilecancel',active:true,is_default:false,livemode:false,login_page:{enabled:false},business_profile:{privacy_policy_url:null,terms_of_service_url:null},
    features:{subscription_cancel:{enabled:true,mode:'at_period_end',proration_behavior:'none'},customer_update:{enabled:false},invoice_history:{enabled:false},
      payment_method_update:{enabled:false},subscription_update:{enabled:false},subscription_pause:{enabled:false}}}
  const calls=[];let returnedUrl='https://billing.stripe.com/p/session/test_fixture'
  f.stripe.subscriptions.retrieve=async(id)=>{assert.equal(id,'sub_cancel');return structuredClone(subscription)}
  f.stripe.billingPortal={configurations:{retrieve:async()=>structuredClone(configuration)},sessions:{create:async(params)=>{
    calls.push(params);return{customer:'cus_cancel',configuration:'bpc_mobilecancel',livemode:false,url:returnedUrl}
  }}}
  await t.test('members, non-owner managers, missing subscriptions and locked sessions cannot open a billing link',async()=>{
    for(const accountId of ['member','manager','other'])await assert.rejects(f.lib.prepareWebBillingCancellation({...scope,accountId}),{status:403})
    await assert.rejects(f.lib.prepareWebBillingCancellation(await f.household()),{status:404})
    await f.db.query('insert into native_notification_installations(device_id,secret_hash) values($1,$2)',[scope.deviceId,'b'.repeat(64)])
    await f.db.query(`insert into native_kiosk_sessions(id,household_id,user_id,session_id,device_id,visible_member_ids,editable_member_ids,state,exit_secret_hash,request_hash)
      values($1,$2,$3,$4,$5,array[$3],array[$3],'locked',$6,$6)`,[randomUUID(),scope.householdId,scope.accountId,scope.sessionId,scope.deviceId,'a'.repeat(64)])
    assert.equal((await f.route.POST(f.request(scope,{action:'webCancellation'}))).status,423)
    await f.db.query('delete from native_kiosk_sessions where session_id=$1',[scope.sessionId])
    assert.equal(calls.length,0)
  })
  await t.test('the link works with native purchase rollout off and preserves current paid access',async()=>{
    process.env.NATIVE_BILLING_ENABLED='false'
    const before=(await f.db.query('select * from household_billing where household_id=$1',[scope.householdId])).rows[0]
    const response=await f.route.POST(f.request(scope,{action:'webCancellation'})),body=await response.json()
    assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(body.url,returnedUrl)
    assert.equal(body.sessionId,scope.sessionId);assert.equal(f.limits.at(-1),'billing')
    assert.deepEqual(calls.at(-1),{customer:'cus_cancel',configuration:'bpc_mobilecancel',return_url:'https://cyntch.test/mobile/billing/return',
      flow_data:{type:'subscription_cancel',subscription_cancel:{subscription:'sub_cancel'},after_completion:{type:'redirect',redirect:{return_url:'https://cyntch.test/mobile/billing/return'}}}})
    assert.deepEqual((await f.db.query('select * from household_billing where household_id=$1',[scope.householdId])).rows[0],before)
    process.env.NATIVE_BILLING_ENABLED='true'
  })
  await t.test('changed or unsafe provider state fails closed without using the default portal',async()=>{
    const before=calls.length, good=structuredClone(subscription)
    for(const patch of [{customer:'cus_other'},{metadata:{household_id:randomUUID()}},{cancel_at_period_end:true},{cancel_at:123},{status:'canceled'},
      {items:{has_more:true,data:good.items.data}},{items:{has_more:false,data:[{price:{id:'price_other'},quantity:1}]}},{livemode:true}]){
      subscription={...good,...patch};await assert.rejects(f.lib.prepareWebBillingCancellation(scope),{status:409})
    }
    subscription=good
    for(const feature of ['customer_update','invoice_history','payment_method_update','subscription_update','subscription_pause']){
      configuration.features[feature].enabled=true;await assert.rejects(f.lib.prepareWebBillingCancellation(scope),{status:503});configuration.features[feature].enabled=false
    }
    configuration.is_default=true;await assert.rejects(f.lib.prepareWebBillingCancellation(scope),{status:503});configuration.is_default=false
    configuration.features.subscription_cancel.mode='immediately';await assert.rejects(f.lib.prepareWebBillingCancellation(scope),{status:503});configuration.features.subscription_cancel.mode='at_period_end'
    assert.equal(calls.length,before)
    returnedUrl='https://evil.test/p/session/test_fixture';await assert.rejects(f.lib.prepareWebBillingCancellation(scope),{status:503});returnedUrl='https://billing.stripe.com/p/session/test_fixture'
  })
  await t.test('slow provider reads do not block task writes; changed ownership prevents returning the session',async()=>{
    let release,reached;const gate=new Promise(resolve=>{release=resolve}),entered=new Promise(resolve=>{reached=resolve})
    const create=f.stripe.billingPortal.sessions.create
    f.stripe.billingPortal.sessions.create=async(params)=>{reached();await gate;return create(params)}
    const work=f.lib.prepareWebBillingCancellation(scope);await entered
    await f.lib.withHouseholdWrite(scope.householdId,scope.accountId,async client=>{await client.query("update households set leader_id='other' where id=$1",[scope.householdId])})
    release();await assert.rejects(work,{status:403})
    await f.db.query("update households set leader_id='parent' where id=$1",[scope.householdId])
    f.stripe.billingPortal.sessions.create=create
  })
})

test('mobile billing replies are fenced to account, session, household, device and purchase; client clocks do not decide authorization', async t => {
  const { MobileApi } = load(['mobile/src/services/api.ts'], {})
  const scope = { accountId: 'parent', sessionId: 'session', householdId: randomUUID(), deviceId: randomUUID() }
  const api = new MobileApi('https://cyntch.test', scope.accountId, scope.deviceId, async () => 'fixture-token', undefined, scope.sessionId)
  const previousFetch = global.fetch, previousNow = Date.now
  t.after(() => { global.fetch = previousFetch; Date.now = previousNow })
  let response = scope
  global.fetch = async (_url, init) => {
    assert.equal(init.headers['X-Cyntch-Session'], scope.sessionId); assert.equal(init.headers['X-Task-Save-User'], scope.accountId)
    return Response.json(response)
  }
  for (const field of ['accountId', 'sessionId', 'householdId', 'deviceId']) {
    response = { ...scope, [field]: 'changed' }
    await assert.rejects(api.billingStatus(scope.householdId), /different account/)
  }
  const operationId = randomUUID(), action = { action: 'begin', householdId: scope.householdId, store: 'app_store', interval: 'monthly', operationId }
  response = { ...scope, operationId: randomUUID(), expiresAt: '2027-01-01T00:00:00.000Z' }
  await assert.rejects(api.billingPurchase(action), /did not match/)
  response.operationId = operationId
  Date.now = () => Date.parse('2099-01-01T00:00:00Z')
  assert.equal((await api.billingPurchase(action)).operationId, operationId)
  response = { ...scope, billingCustomerId: randomUUID(), publicSdkKey: 'appl_fixture', environment: 'production', store: 'app_store',
    products: [{ interval: 'monthly', storeProductId: 'monthly' }, { interval: 'yearly', storeProductId: 'yearly' }] }
  assert.equal((await api.prepareBilling(scope.householdId, 'app_store')).publicSdkKey, 'appl_fixture')
  response.publicSdkKey = 'sk_secret'; await assert.rejects(api.prepareBilling(scope.householdId, 'app_store'), /invalid store configuration/)
})

async function fixture(t) {
  const target = new URL(connectionString)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
  const schema = `billing_actions_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString })
  await admin.query(`create schema ${schema}`)
  const db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 })
  t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  for (const name of ['app_role', 'routine_type', 'task_status', 'occurrence_status', 'notification_kind']) {
    const labels = (await admin.query(`select e.enumlabel from pg_enum e join pg_type p on p.oid=e.enumtypid join pg_namespace n on n.oid=p.typnamespace
      where p.typname=$1 and n.nspname='public' order by e.enumsortorder`, [name])).rows
    if (labels.length) await db.query(`create type ${name} as enum (${labels.map(row => "'" + row.enumlabel.replaceAll("'", "''") + "'").join(',')})`)
  }
  for (const file of fs.readdirSync(path.join(root, 'database')).filter(name => name.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(root, 'database', file), 'utf8'))
  await db.query(fs.readFileSync(path.join(root, 'database/0032_billing_purchase_attempts.sql'), 'utf8'))
  const env = { NATIVE_BILLING_ENABLED: 'true', NATIVE_BILLING_ENVIRONMENT: 'production', FREEMIUM_ENFORCEMENT_ENABLED: 'true',
    REVENUECAT_PROJECT_ID: 'proj_test', REVENUECAT_V1_SECRET_KEY: 'secret_fixture_v1', REVENUECAT_V2_SECRET_KEY: 'secret_fixture_v2',
    REVENUECAT_NATIVE_PRODUCTS: JSON.stringify(products), REVENUECAT_IOS_PUBLIC_KEY: 'appl_fixture', REVENUECAT_ANDROID_PUBLIC_KEY: 'goog_fixture',
    STRIPE_NATIVE_CANCEL_PORTAL_CONFIG_ID: 'bpc_mobilecancel', STRIPE_MONTHLY_PRICE_ID: 'price_monthly', STRIPE_YEARLY_PRICE_ID: 'price_yearly' }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])), previousFetch = global.fetch
  Object.assign(process.env, env)
  t.after(() => { global.fetch = previousFetch; for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  let provider = async () => Response.json({ object: 'list', items: [] }), authState = { userId: 'parent', sessionId: 'session_parent' }
  global.fetch = (...args) => provider(...args)
  const stripe = { subscriptions: { list: async () => ({ data: [], has_more: false }) },
    customers: { create: async () => ({ id: 'cus_fixture' }) },
    checkout: { sessions: { list: async () => ({ data: [], has_more: false }), expire: async () => ({}), create: async () => ({ url: 'https://checkout.stripe.test/fixture' }) } } }
  const callbacks = [], limits = []
  const mocks = { '@/lib/db': { db, kioskGateDb: db }, '@clerk/nextjs/server': { auth: async () => authState, clerkClient: async () => assert.fail('fixture user needs no Clerk request') },
    '@/lib/stripe-billing': { stripeClient: () => stripe, validatedPrice: async interval => ({ id: `price_${interval}` }), billingOrigin: () => 'https://cyntch.test' },
    '@/lib/usage-controls': { enforceRequestLimit: async (_user, operation) => limits.push(operation) },
    'next/server': { after: callback => callbacks.push(callback), NextResponse: { json: Response.json } }, '@/lib/run-native-billing': { runNativeBilling: async () => ({ ok: true }) } }
  const lib = load(['lib/native-billing-actions.ts', 'lib/native-billing-management.ts', 'lib/billing-purchase-attempts.ts', 'lib/entitlements.ts', 'lib/native-billing-store.ts', 'lib/native-billing-jobs.ts', 'lib/revenuecat-native-billing.ts'], mocks)
  const route = load(['app/api/mobile/billing/route.ts'], mocks), web = load(['app/api/billing/checkout/route.ts'], mocks)
  for (const user of ['parent', 'member', 'manager', 'other']) await db.query('insert into users(id) values($1)', [user])
  async function household() {
    const householdId = (await db.query("insert into households(name,leader_id) values('Billing family','parent') returning id")).rows[0].id
    for (const [user, role] of [['parent', 'manager'], ['member', 'member'], ['manager', 'manager']]) {
      await db.query('insert into household_members(household_id,user_id,role) values($1,$2,$3)', [householdId,user,role])
    }
    return { householdId, accountId: 'parent', sessionId: 'session_parent', deviceId: randomUUID() }
  }
  function request(scope, action, headerChanges = {}) {
    return new Request(`https://cyntch.test/api/mobile/billing?householdId=${scope.householdId}`, {
      method: action ? 'POST' : 'GET', headers: { 'X-Task-Save-User': scope.accountId, 'X-Cyntch-Session': scope.sessionId, 'X-Cyntch-Device': scope.deviceId, ...headerChanges },
      ...(action ? { body: JSON.stringify({ householdId: scope.householdId, ...action }) } : {}),
    })
  }
  const action = (overrides = {}) => ({ action: 'begin', store: 'app_store', interval: 'monthly', operationId: randomUUID(), ...overrides })
  const webRequest = scope => new Request('https://cyntch.test/api/billing/checkout', { method: 'POST', headers: { origin: 'https://cyntch.test' }, body: JSON.stringify({ householdId: scope.householdId, interval: 'monthly' }) })
  const attempts = async scope => (await db.query('select * from billing_purchase_attempts where household_id=$1 order by created_at', [scope.householdId])).rows
  return { db, lib, route, web, stripe, callbacks, limits, household, request, action, webRequest, attempts,
    setProvider: fn => { provider = fn }, setAuth: value => { authState = value } }
}

test('native billing purchase admission, account isolation and web checkout recover from interrupted requests', { skip: !connectionString }, async t => {
  const f = await fixture(t)
  await t.test('status is membership scoped; only the household owner receives store identity and billing details', async () => {
    const scope = await f.household(), setup = await f.lib.prepareNativeBilling(scope, 'app_store')
    assert.equal(setup.publicSdkKey, 'appl_fixture'); assert.notEqual(setup.billingCustomerId, scope.householdId)
    assert.deepEqual(setup.products.map(product => product.interval), ['monthly', 'yearly'])
    assert.equal(JSON.stringify(setup).includes('secret_fixture'), false)
    assert.equal((await f.lib.prepareNativeBilling(scope, 'play_store')).billingCustomerId, setup.billingCustomerId)
    for (const accountId of ['member', 'manager']) {
      const status = await f.lib.readNativeBillingStatus({ ...scope, accountId })
      assert.equal(status.canManage, false); assert.equal(status.purchasesAvailable, false); assert.deepEqual(status.sources, [])
      await assert.rejects(f.lib.prepareNativeBilling({ ...scope, accountId }, 'app_store'), { status: 403 })
    }
    await assert.rejects(f.lib.readNativeBillingStatus({ ...scope, accountId: 'other' }), { status: 403 })
    const oldKey = process.env.REVENUECAT_IOS_PUBLIC_KEY
    process.env.REVENUECAT_IOS_PUBLIC_KEY = 'sk_secret'
    await assert.rejects(f.lib.prepareNativeBilling(scope, 'app_store'), { status: 503 })
    process.env.REVENUECAT_IOS_PUBLIC_KEY = oldKey
  })
  await t.test('two devices and web checkout cannot reserve alongside a native purchase; provider I/O does not hold the household lock', async () => {
    const scope = await f.household(), action = f.action()
    let fetched, finish
    const reached = new Promise(resolve => { fetched = resolve }), pending = new Promise(resolve => { finish = resolve })
    f.setProvider(async () => { fetched(); return pending })
    const purchasing = f.lib.beginNativeBillingPurchase(scope, action)
    await reached
    assert.equal((await f.attempts(scope))[0].state, 'reserved')
    await f.lib.withHouseholdWrite(scope.householdId, 'parent', async client => { await client.query('select 1') })
    await assert.rejects(f.lib.beginNativeBillingPurchase({ ...scope, deviceId: randomUUID() }, f.action({ store: 'play_store' })), { code: 'purchase_in_progress' })
    assert.equal((await f.web.POST(f.webRequest(scope))).status, 409)
    finish(Response.json({ object: 'list', items: [] })); const allowed = await purchasing
    assert.equal(allowed.operationId, action.operationId); assert.equal((await f.attempts(scope))[0].state, 'submitted')
    f.setProvider(async () => Response.json({ object: 'list', items: [] }))
    assert.equal((await f.lib.beginNativeBillingPurchase(scope, action)).expiresAt, allowed.expiresAt, 'replay must not extend a hold')
    assert.equal((await f.lib.processNativeBillingJobs(f.db, f.lib.revenueCatConfig(), { limit: 1 })).verified, 1)
    const followup = (await f.db.query(`select j.next_attempt_at from native_billing_jobs j join native_billing_accounts a on a.id=j.account_id
      where a.household_id=$1`, [scope.householdId])).rows[0].next_attempt_at.getTime() - Date.now()
    assert.ok(followup > 50_000 && followup <= 61_000, 'an unreported store result must get a near-term durable check')
    await assert.rejects(f.lib.cancelNativeBillingPurchase({ ...scope, sessionId: 'different_session' }, action), { code: 'attempt_mismatch' })
    await f.lib.cancelNativeBillingPurchase(scope, action); await f.lib.cancelNativeBillingPurchase(scope, action)
    await assert.rejects(f.lib.beginNativeBillingPurchase(scope, action), { code: 'attempt_expired' })
    assert.equal((await f.lib.beginNativeBillingPurchase(scope, f.action())).householdId, scope.householdId)
  })
  await t.test('timeouts keep a durable reservation and do not grant access; expiring it never makes its old operation reusable', async () => {
    const scope = await f.household(), action = f.action()
    f.setProvider(async () => { throw new Error('simulated timeout') })
    await assert.rejects(f.lib.beginNativeBillingPurchase(scope, action), { code: 'request' })
    assert.equal((await f.attempts(scope))[0].state, 'reserved')
    assert.equal((await f.lib.readNativeBillingStatus(scope)).tier, 'free')
    await f.db.query("update billing_purchase_attempts set expires_at=now()-interval '1 second' where household_id=$1", [scope.householdId])
    f.setProvider(async () => Response.json({ object: 'list', items: [] }))
    await f.lib.beginNativeBillingPurchase(scope, f.action({ store: 'play_store' }))
    await assert.rejects(f.lib.beginNativeBillingPurchase(scope, action), { code: 'attempt_expired' })
    assert.equal((await f.attempts(scope)).filter(attempt => attempt.state === 'submitted').length, 1)
  })
  await t.test('server verified pending payments, paused subscriptions and unknown states prevent another charge without granting access', async () => {
    for (const [status, pending] of [['expired', true], ['paused', false], ['unknown', false], ['in_billing_retry', false]]) {
      const scope = await f.household(), setup = await f.lib.prepareNativeBilling(scope, 'app_store')
      f.setProvider(async () => Response.json({ object: 'list', items: [{ object: 'subscription', id: randomUUID(), customer_id: setup.billingCustomerId,
        original_customer_id: setup.billingCustomerId, product_id: 'app_store_monthly', environment: 'production', store: 'app_store', ownership: 'purchased',
        gives_access: false, pending_payment: pending, status, auto_renewal_status: 'will_renew', ends_at: null, current_period_ends_at: null }] }))
      await assert.rejects(f.lib.beginNativeBillingPurchase(scope, f.action()), { code: 'existing_subscription' })
      const result = await f.lib.readNativeBillingStatus(scope)
      assert.equal(result.tier, 'free'); assert.equal(result.sources[0].pendingPayment, pending)
      assert.equal((await f.attempts(scope))[0].state, 'released', 'verified subscription takes over duplicate protection')
      assert.equal((await f.web.POST(f.webRequest(scope))).status, 409)
    }
    f.setProvider(async () => Response.json({ object: 'list', items: [] }))
  })
  await t.test('confirmed store access ends the temporary recovery hold and reports duplicate provider access', async () => {
    const scope = await f.household(), action = f.action()
    await f.lib.beginNativeBillingPurchase(scope, action)
    const setup = await f.lib.prepareNativeBilling(scope, 'app_store')
    const account = await f.lib.beginNativeBillingVerification(f.db, setup.billingCustomerId)
    await f.lib.applyNativeBillingSnapshot(f.db, account.id, account.revision, [{ id: randomUUID(), originalCustomerId: account.id, environment: 'production',
      store: 'app_store', productId: 'app_store_monthly', status: 'active', autoRenewalStatus: 'will_renew', givesAccess: true, pendingPayment: false,
      accessThrough: new Date(Date.now() + 86400_000).toISOString() }])
    assert.equal((await f.attempts(scope))[0].state, 'released')
    assert.equal((await f.lib.readNativeBillingStatus(scope)).purchase, null)
    await f.db.query(`insert into household_billing(household_id,stripe_subscription_id,subscription_status,paid_through)
      values($1,$2,'active',now()+interval '30 days')`, [scope.householdId, `sub_${scope.householdId}`])
    const result = await f.lib.readNativeBillingStatus(scope)
    assert.equal(result.tier, 'premium'); assert.equal(result.duplicateSubscriptions, true)
    await assert.rejects(f.lib.beginNativeBillingPurchase(scope, f.action({ store: 'play_store' })), { code: 'existing_subscription' })
  })
  await t.test('sandbox verification cannot release a production purchase reservation or grant production access', async () => {
    const scope = await f.household()
    await f.lib.beginNativeBillingPurchase(scope, f.action())
    const account = await f.lib.ensureNativeBillingAccount(f.db, scope.householdId, 'proj_test', 'sandbox')
    const verification = await f.lib.beginNativeBillingVerification(f.db, account.id)
    await f.lib.applyNativeBillingSnapshot(f.db, account.id, verification.revision, [{ id: randomUUID(), originalCustomerId: account.id, environment: 'sandbox',
      store: 'app_store', productId: 'app_store_monthly', status: 'active', autoRenewalStatus: 'will_renew', givesAccess: true, pendingPayment: false,
      accessThrough: new Date(Date.now() + 86400_000).toISOString() }])
    assert.equal((await f.attempts(scope))[0].state, 'submitted')
    assert.equal((await f.lib.readNativeBillingStatus(scope)).tier, 'free')
  })
  await t.test('a household becoming Premium while verification is in flight cannot receive purchase permission', async () => {
    const scope = await f.household()
    f.setProvider(async () => {
      await f.db.query("insert into household_billing(household_id,subscription_status,paid_through) values($1,'active',now()+interval '30 days')", [scope.householdId])
      return Response.json({ object: 'list', items: [] })
    })
    await assert.rejects(f.lib.beginNativeBillingPurchase(scope, f.action()), { code: 'existing_subscription' })
    assert.equal((await f.attempts(scope))[0].state, 'reserved')
    f.setProvider(async () => Response.json({ object: 'list', items: [] }))
  })
  await t.test('a fresh Stripe check blocks live/open subscriptions absent from cached entitlement; failed provider requests fail closed', async () => {
    const scope = await f.household()
    await f.db.query("insert into household_billing(household_id,stripe_customer_id) values($1,$2)", [scope.householdId, `cus_${scope.householdId}`])
    const action = f.action()
    f.stripe.subscriptions.list = async () => ({ data: [{ status: 'past_due' }], has_more: false })
    await assert.rejects(f.lib.beginNativeBillingPurchase(scope, action), { code: 'existing_subscription' })
    f.stripe.subscriptions.list = async () => ({ data: [], has_more: false })
    f.stripe.checkout.sessions.list = async () => ({ data: [{ mode: 'subscription' }], has_more: false })
    await assert.rejects(f.lib.beginNativeBillingPurchase(scope, action), { code: 'purchase_in_progress' })
    f.stripe.checkout.sessions.list = async () => { throw new Error('Stripe unavailable') }
    await assert.rejects(f.lib.beginNativeBillingPurchase(scope, action), /Stripe unavailable/)
    assert.equal((await f.attempts(scope))[0].state, 'reserved')
    f.stripe.checkout.sessions.list = async () => ({ data: [], has_more: false })
    await f.lib.beginNativeBillingPurchase(scope, action)
  })
  await t.test('a failed purchase check settles both providers before allowing an immediate retry', async () => {
    const scope = await f.household(), action = f.action()
    await f.db.query("insert into household_billing(household_id,stripe_customer_id) values($1,$2)", [scope.householdId, `cus_${scope.householdId}`])
    let release, reachedNative, reachedStripe, settled = false
    const gate = new Promise(resolve => { release = resolve })
    const nativeReached = new Promise(resolve => { reachedNative = resolve })
    const stripeReached = new Promise(resolve => { reachedStripe = resolve })
    f.setProvider(async () => { reachedNative(); await gate; return Response.json({ object: 'list', items: [] }) })
    const previousList = f.stripe.subscriptions.list
    f.stripe.subscriptions.list = async () => { reachedStripe(); throw new Error('Stripe unavailable during admission') }
    const work = f.lib.beginNativeBillingPurchase(scope, action)
    const observed = work.then(() => { settled = true }, () => { settled = true })
    try {
      await Promise.all([nativeReached, stripeReached]); await new Promise(resolve => setImmediate(resolve))
      assert.equal(settled, false, 'Provider failure must not leave verification writes running after the response')
      await f.lib.withHouseholdWrite(scope.householdId, scope.accountId, async client => { await client.query('select 1') })
      release(); await assert.rejects(work, /Stripe unavailable during admission/); await observed
      f.stripe.subscriptions.list = previousList
      const retried = await f.lib.beginNativeBillingPurchase(scope, action)
      assert.equal(retried.operationId, action.operationId)
      assert.equal((await f.attempts(scope))[0].state, 'submitted')
    } finally {
      release(); await observed
      f.stripe.subscriptions.list = previousList
      f.setProvider(async () => Response.json({ object: 'list', items: [] }))
    }
  })
  await t.test('a lost Stripe create response reuses durable expiry, integration label and idempotency key', async () => {
    const scope = await f.household(), creates = []
    f.stripe.customers.create = async () => ({ id: `cus_${scope.householdId}` })
    f.stripe.checkout.sessions.create = async (body, options) => {
      creates.push({ body, options })
      if (creates.length === 1) throw new Error('provider accepted; response lost')
      return { url: 'https://checkout.stripe.test/recovered' }
    }
    assert.equal((await f.web.POST(f.webRequest(scope))).status, 503)
    assert.equal((await f.attempts(scope)).length, 1)
    const retried = await f.web.POST(f.webRequest(scope))
    assert.equal(retried.status, 200); assert.equal((await retried.json()).url, 'https://checkout.stripe.test/recovered')
    assert.deepEqual(creates[0], creates[1]); assert.match(creates[0].body.integration_identifier, /^cyntch_[a-z]{8}$/)
    assert.match(creates[0].options.idempotencyKey, /^cyntch-checkout-/)
    await assert.rejects(f.lib.beginNativeBillingPurchase(scope, f.action()), { code: 'purchase_in_progress' })
  })
  await t.test('billing API fences accounts, sessions and invalid input; restore callbacks persist verification before background work', async () => {
    const scope = await f.household()
    for (const change of [{ 'X-Task-Save-User': 'other' }, { 'X-Cyntch-Session': 'old' }]) {
      assert.equal((await f.route.GET(f.request(scope, null, change))).status, 403)
    }
    assert.equal((await f.route.POST(f.request(scope, f.action({ operationId: 'invalid' })))).status, 400)
    assert.equal((await f.route.POST(f.request(scope, { action: 'prepare', store: 'amazon' }))).status, 400)
    const prepared = await f.route.POST(f.request(scope, { action: 'prepare', store: 'app_store' }))
    assert.equal(prepared.status, 200); assert.equal(prepared.headers.get('cache-control'), 'no-store')
    const setup = await prepared.json()
    const callbacksBefore = f.callbacks.length
    const verified = await f.route.POST(f.request(scope, { action: 'verify', givesAccess: true, paidThrough: '2099-01-01' }))
    assert.equal(verified.status, 200)
    const result = await verified.json(); assert.equal(result.verificationPending, true); assert.equal(result.tier, 'free')
    assert.equal(f.callbacks.length, callbacksBefore + 1)
    const job = (await f.db.query('select * from native_billing_jobs where account_id=$1', [setup.billingCustomerId])).rows[0]
    assert.equal(job.completed_generation, '0'); assert.equal(job.requested_generation, '1')
    // Simulate process death before after(): a newly loaded worker sees the job.
    await f.db.query("update native_billing_jobs set next_attempt_at=now()+interval '1 day' where account_id<>$1", [setup.billingCustomerId])
    assert.equal((await f.lib.processNativeBillingJobs(f.db, f.lib.revenueCatConfig(), { limit: 1 })).verified, 1)
    assert.equal((await f.db.query('select completed_generation from native_billing_jobs where account_id=$1', [setup.billingCustomerId])).rows[0].completed_generation, '1')
    assert.equal((await f.lib.readNativeBillingStatus(scope)).tier, 'free')
  })
  await t.test('kiosk sessions cannot read billing or begin, restore or cancel purchases, including through a different device header', async () => {
    const scope = { ...await f.household(), sessionId: 'session_kiosk' }
    await f.db.query('insert into native_notification_installations(device_id,secret_hash) values($1,$2)', [scope.deviceId,'a'.repeat(64)])
    await f.db.query(`insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash)
      values($1,'parent',$2,$3,$4,array['member'],array['member'],$5,$5)`, [randomUUID(),scope.sessionId,scope.deviceId,scope.householdId,'b'.repeat(64)])
    f.setAuth({ userId: 'parent', sessionId: scope.sessionId })
    try {
      assert.equal((await f.route.GET(f.request(scope))).status, 423)
      for (const action of [f.action(), { action: 'prepare', store: 'app_store' }, { action: 'verify' }, f.action({ action: 'cancel' })]) {
        assert.equal((await f.route.POST(f.request(scope, action, { 'X-Cyntch-Device': randomUUID() }))).status, 423)
      }
      assert.equal((await f.web.POST(f.webRequest(scope))).status, 423)
      assert.equal((await f.attempts(scope)).length, 0)
    } finally { f.setAuth({ userId: 'parent', sessionId: 'session_parent' }) }
  })
  await t.test('feature-off web billing never touches the new reservation tables', async () => {
    const scope = await f.household()
    process.env.NATIVE_BILLING_ENABLED = 'false'
    await f.db.query('alter table billing_purchase_attempts rename to hidden_billing_purchase_attempts')
    f.stripe.customers.create = async () => ({ id: `cus_${scope.householdId}` })
    f.stripe.checkout.sessions.create = async (_body, options) => { assert.equal(options, undefined); return { url: 'https://checkout.stripe.test/legacy' } }
    try { assert.equal((await f.web.POST(f.webRequest(scope))).status, 200) }
    finally { await f.db.query('alter table hidden_billing_purchase_attempts rename to billing_purchase_attempts'); process.env.NATIVE_BILLING_ENABLED = 'true' }
  })
})
