/* eslint-disable @typescript-eslint/no-require-imports -- Explicitly invoked test-mode provider verification. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process')
const {fixture}=require('../helpers/account-deletion.cjs')

test('actual Stripe test customer deletion cancels billing and preserves the transferred paid period',{
 skip:process.env.CYNTCH_STRIPE_SANDBOX_TEST!=='true',timeout:120000,
},async t=>{
 const cli=process.env.CYNTCH_STRIPE_CLI;assert.ok(cli&&path.isAbsolute(cli),'An explicit current Stripe CLI path is required')
 function command(args){
  const result=cp.spawnSync(cli,args,{encoding:'utf8',windowsHide:true,timeout:12000})
  if(result.error)throw Error('Stripe CLI request interrupted')
  let parsed;try{parsed=JSON.parse(result.stdout)}catch{throw Error('Stripe CLI returned an invalid response')}
  if(result.status!==0||parsed.error)throw Error(`Stripe CLI request failed: ${parsed.error?.type??'exit'} / ${parsed.error?.code??'unknown'}`)
  return parsed
 }
 const identity=command(['whoami','--format','json']);assert.equal(identity.mode,'test');assert.equal(identity.authorized,true)
 const fields=(value,prefix='')=>Object.entries(value).flatMap(([key,item])=>{
  const name=prefix?`${prefix}[${key}]`:key
  return item&&typeof item==='object'?fields(item,name):[`${name}=${item}`]
 })
 function api(method,resource,data={}){
  const response=command([method,resource,'--color','off','--stripe-version','2026-10-28.endive',...fields(data).flatMap(field=>['-d',field]),...(['post','delete'].includes(method)?['--confirm']:[])])
  if('livemode'in response)assert.equal(response.livemode,false)
  return response
 }
 assert.equal(api('get','/v1/balance').livemode,false,'Never create financial test fixtures in live mode')
 const run=randomUUID(),file=path.join(os.tmpdir(),`cyntch-deletion-stripe-${run}.json`)
 const evidence={run,mode:'test',customers:[],prices:[],clocks:[],product:null,verified:false,cleaned:false}
 const save=()=>fs.writeFileSync(file,JSON.stringify(evidence,null,2))
 save()
 t.after(()=>{
  for(const id of evidence.customers){const current=api('get',`/v1/customers/${id}`);if(!current.deleted)api('delete',`/v1/customers/${id}`)}
  for(const id of evidence.clocks)api('delete',`/v1/test_helpers/test_clocks/${id}`)
  for(const id of evidence.prices)api('post',`/v1/prices/${id}`,{active:false})
  if(evidence.product)api('post',`/v1/products/${evidence.product}`,{active:false})
  evidence.cleaned=true;save();console.log('Test-mode cleanup evidence:',file)
 })
 const f=await fixture(t)
 evidence.product=api('post','/v1/products',{name:`Cyntch deletion verification ${run}`,metadata:{test_run:run}}).id;save()
 const price=api('post','/v1/prices',{product:evidence.product,currency:'aud',unit_amount:599,recurring:{interval:'month'},metadata:{test_run:run}})
 evidence.prices.push(price.id);save()
 const bindings=[]
 for(const householdId of [f.transfer,f.deleting]){
  const customer=api('post','/v1/customers',{metadata:{app:'cyntch',household_id:householdId,test_run:run},payment_method:'pm_card_visa',invoice_settings:{default_payment_method:'pm_card_visa'}})
  evidence.customers.push(customer.id);save()
  const subscription=api('post','/v1/subscriptions',{customer:customer.id,items:[{price:price.id}],metadata:{app:'cyntch',household_id:householdId,test_run:run}})
  assert.equal(subscription.status,'active')
  await f.db.query(`update household_billing set stripe_customer_id=$2,stripe_subscription_id=$3,subscription_status='active',
    paid_through=to_timestamp($4) where household_id=$1`,[householdId,customer.id,subscription.id,subscription.items.data[0].current_period_end])
  bindings.push({householdId,customerId:customer.id,subscriptionId:subscription.id})
 }
 const clock=api('post','/v1/test_helpers/test_clocks',{frozen_time:Math.floor(Date.now()/1000),name:`Cyntch deletion ${run}`})
 evidence.clocks.push(clock.id);save()
 const orphan=api('post','/v1/customers',{test_clock:clock.id,metadata:{app:'cyntch',household_id:f.transfer,test_run:run},payment_method:'pm_card_visa',invoice_settings:{default_payment_method:'pm_card_visa'}})
 evidence.customers.push(orphan.id);save()
 const orphanSubscription=api('post','/v1/subscriptions',{customer:orphan.id,items:[{price:price.id}],metadata:{app:'cyntch',household_id:f.transfer,test_run:run}})
 assert.equal(orphanSubscription.status,'active')
 bindings.push({householdId:f.transfer,customerId:orphan.id,subscriptionId:orphanSubscription.id})
 // Deliberately no database binding: this represents an old interrupted checkout.
 const intent=await f.intent();await f.accept(intent)
 const leaseId=randomUUID();await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[intent.operationId,leaseId])
 const job={id:intent.operationId,accountId:f.owner,leaseId,work:(await f.db.query('select work from account_deletion_requests where id=$1',[intent.operationId])).rows[0].work}
 await f.lib.deleteAccountData(f.db,job)
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{phases,data}','true') where id=$1`,[job.id])
 const before=(await f.db.query('select paid_through from household_billing where household_id=$1',[f.transfer])).rows[0].paid_through
 let loseResponse=true
 const client={testHelpers:{testClocks:{list:async params=>api('get','/v1/test_helpers/test_clocks',params)}},
 customers:{list:async params=>api('get','/v1/customers',params),retrieve:async id=>api('get',`/v1/customers/${id}`),del:async id=>{
  assert.ok(evidence.customers.includes(id),'Delete only a customer created by this test')
  const result=api('delete',`/v1/customers/${id}`)
  if(loseResponse){loseResponse=false;throw Error('Simulated lost response after an actual Stripe deletion')}
  return result
 }},subscriptions:{retrieve:async id=>api('get',`/v1/subscriptions/${id}`)}}
 const {deleteAccountStripeData}=f.load(['lib/account-deletion-stripe.ts'])
 await assert.rejects(deleteAccountStripeData(f.db,job,{client,livemode:false}),{code:'stripe_cleanup_failed'})
 await deleteAccountStripeData(f.db,job,{client,livemode:false})
 for(const binding of bindings){
  assert.equal(api('get',`/v1/customers/${binding.customerId}`).deleted,true)
  assert.equal(api('get',`/v1/subscriptions/${binding.subscriptionId}`).status,'canceled')
 }
 const after=(await f.db.query('select * from household_billing where household_id=$1',[f.transfer])).rows[0]
 assert.deepEqual(after.paid_through,before);assert.equal(after.subscription_status,'canceled');assert.ok(after.stripe_customer_deleted_at)
 evidence.verified=true;evidence.subscriptionCancellation=true;evidence.lostResponseRecovery=true;evidence.transferredPaidPeriodPreserved=true;evidence.unboundClockCustomerDiscovered=true;save()
})
