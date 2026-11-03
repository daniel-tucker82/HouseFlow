/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness compiles TypeScript modules with isolated dependency mocks. */
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {buildSync} = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const Stripe = require('stripe')
const secret = 'whsec_unit_test_only'
process.env.STRIPE_SECRET_KEY = 'sk_test_unit_test_only'
process.env.STRIPE_WEBHOOK_SECRET = secret
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const receipts = new Map()
let reconciled = 0, fail = false
const filename = path.resolve(__dirname,'../app/api/billing/webhook/route.ts')
const compiled = buildSync({entryPoints:[filename],bundle:true,platform:'node',format:'cjs',write:false,
  external:['next/server','@/lib/db','@/lib/stripe-billing']})
const loaded = new Module(filename,module)
loaded.paths = module.paths
const original = loaded.require.bind(loaded)
loaded.require = id => {
  if(id === '@/lib/stripe-billing') return {
    stripeClient:()=>stripe,
    reconcileHouseholdSubscription:async()=>{if(fail)throw Error('Temporary failure');reconciled++},
  }
  if(id === '@/lib/db') return {db:{query:async(sql,args)=>{
    if(sql.startsWith('insert into billing_webhook_events')) {if(!receipts.has(args[0]))receipts.set(args[0],{processed_at:null});return {rows:[]}}
    if(sql.startsWith('select processed_at'))return {rows:[receipts.get(args[0])]}
    if(sql.includes('from household_billing'))return {rows:[{household_id:'household-one'}]}
    if(sql.includes('set processed_at = now()'))receipts.get(args[0]).processed_at=new Date()
    return {rows:[]}
  }}}
  return original(id)
}
loaded._compile(compiled.outputFiles[0].text,filename)
const {POST} = loaded.exports
function request(id,type='invoice.paid',options={}) {
  const body=JSON.stringify({id,type,created:options.created??100,livemode:options.live??false,data:{object:{id:'in_test',customer:'cus_test'}}})
  const signature=stripe.webhooks.generateTestHeaderString({payload:body,secret})
  return new Request('https://example.test/api/billing/webhook',{method:'POST',body,
    headers:{'stripe-signature':options.bad?'invalid':signature}})
}
test('webhook requires a valid signature and matching billing environment',async()=>{
  assert.equal((await POST(request('evt_bad','invoice.paid',{bad:true}))).status,400)
  assert.equal((await POST(request('evt_live','invoice.paid',{live:true}))).status,400)
  assert.equal(receipts.size,0)
})
test('duplicate verified events reconcile only once',async()=>{
  const before=reconciled
  assert.equal((await POST(request('evt_duplicate'))).status,200)
  assert.equal((await POST(request('evt_duplicate'))).status,200)
  assert.equal(reconciled-before,1)
})
test('failed processing remains retryable',async()=>{
  fail=true
  assert.equal((await POST(request('evt_retry'))).status,503)
  assert.equal(receipts.get('evt_retry').processed_at,null)
  fail=false
  assert.equal((await POST(request('evt_retry'))).status,200)
  assert.ok(receipts.get('evt_retry').processed_at)
})
test('delayed lifecycle events request current-state reconciliation',async()=>{
  const before=reconciled
  for(const [id,type,created] of [
    ['evt_new','customer.subscription.deleted',900],
    ['evt_old','invoice.paid',100],
    ['evt_failed','invoice.payment_failed',500],
    ['evt_reactivate','customer.subscription.updated',1000],
  ]) assert.equal((await POST(request(id,type,{created}))).status,200)
  assert.equal(reconciled-before,4)
})
