/* eslint-disable @typescript-eslint/no-require-imports -- Isolated PostgreSQL lifecycle tests with explicit provider doubles. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),options={skip:!connectionString}

async function setup(t,beforeAccept=async()=>{}) {
 const f=await fixture(t)
 await f.db.query("update household_billing set paid_through=now()+interval '20 days' where household_id=$1",[f.transfer])
 await beforeAccept(f)
 const intent=await f.intent();await f.accept(intent)
 const leaseId=randomUUID()
 await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[intent.operationId,leaseId])
 const job={id:intent.operationId,accountId:f.owner,leaseId,work:(await f.db.query('select work from account_deletion_requests where id=$1',[intent.operationId])).rows[0].work}
 await f.lib.deleteAccountData(f.db,job)
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{phases,data}','true') where id=$1`,[job.id])
 const calls=[],listCalls=[],customers=new Map(job.work.stripe.map(item=>[item.customerId,{object:'customer',id:item.customerId,livemode:false,metadata:{household_id:item.householdId,app:'cyntch'}}]))
 const client={customers:{
  list:async(params,request)=>{listCalls.push([params,request]);return {object:'list',data:[...customers.values()].filter(item=>!item.deleted),has_more:false}},
  retrieve:async(id,params,request)=>{calls.push(['retrieve',id,request]);if(!customers.has(id))throw Object.assign(Error('No such customer'),{statusCode:404});return customers.get(id)},
  del:async(id,params,request)=>{calls.push(['delete',id,request]);const result={id,deleted:true};customers.set(id,result);return result},
 },subscriptions:{retrieve:async()=>assert.fail('Customers are already captured')},testHelpers:{testClocks:{list:async()=>({object:'list',data:[],has_more:false})}}}
 const lib=f.load(['lib/account-deletion-stripe.ts'])
 return {...f,job,calls,listCalls,customers,provider:{client,livemode:false},cleanup:()=>lib.deleteAccountStripeData(f.db,job,{client,livemode:false}),adapter:lib.deleteAccountStripeData}
}

test('Stripe cleanup deletes captured customers and preserves the transferred household paid period',options,async t=>{
 const f=await setup(t),before=(await f.db.query('select * from household_billing where household_id=$1',[f.transfer])).rows[0]
 assert.equal(before.stripe_customer_retired,true);assert.equal(before.stripe_customer_deleted_at,null)
 for(const [provider,environment]of [['stripe','sandbox'],['play_store','production']])await f.db.query(`insert into billing_purchase_attempts
  (id,household_id,user_id,session_id,device_id,provider,environment,billing_interval,expires_at,integration_suffix)
  values($1,$2,'deleted','deleted',$5,$3,$4,'monthly',now()+interval '1 hour','abcdefgh')`,[randomUUID(),f.transfer,provider,environment,provider==='stripe'?null:'00000000-0000-0000-0000-000000000000'])
 await f.cleanup()
 assert.equal(f.calls.filter(call=>call[0]==='delete').length,2)
 for(const [, ,request]of f.calls){assert.equal(request.maxNetworkRetries,0);assert.ok(request.timeout>0&&request.timeout<=8000)}
 const after=(await f.db.query('select * from household_billing where household_id=$1',[f.transfer])).rows[0]
 assert.equal(after.subscription_status,'canceled');assert.equal(after.cancel_at_period_end,true)
 assert.deepEqual(after.paid_through,before.paid_through);assert.ok(after.stripe_customer_deleted_at)
 assert.equal(after.stripe_customer_id,before.stripe_customer_id,'Keep financial linkage for refund/revocation processing, not customer portal access')
 const work=(await f.db.query('select work from account_deletion_requests where id=$1',[f.job.id])).rows[0].work
 assert.ok(work.stripe.every(item=>item.completed));assert.equal(work.phases.stripe,false,'Only the coordinator can acknowledge the whole phase')
 assert.deepEqual((await f.db.query('select provider,state from billing_purchase_attempts order by provider')).rows,[{provider:'play_store',state:'reserved'},{provider:'stripe',state:'released'}])
 const count=f.calls.length;await f.cleanup();assert.equal(f.calls.length,count,'Durable per-customer progress avoids duplicate work')
})

test('a lost Stripe deletion response recovers from the deleted customer without a second deletion',options,async t=>{
 const f=await setup(t),del=f.provider.client.customers.del
 let lost=true
 f.provider.client.customers.del=async(...args)=>{const result=await del(...args);if(lost){lost=false;throw Error('Lost response contains private provider details')}return result}
 await assert.rejects(f.cleanup(),{code:'stripe_cleanup_failed',message:'stripe_cleanup_failed'})
 assert.equal(f.calls.filter(call=>call[0]==='delete').length,1)
 await f.cleanup()
 assert.equal(f.calls.filter(call=>call[0]==='delete').length,2,'One delete for each customer, not three')
})

test('Stripe cleanup validates lease, durable scope, provider identity and environment before a mutation',options,async t=>{
 const f=await setup(t),first=f.job.work.stripe[0],customer=f.customers.get(first.customerId)
 for(const job of [{...f.job,accountId:f.other},{...f.job,leaseId:randomUUID()}]) await assert.rejects(f.adapter(f.db,job,f.provider),{code:'stripe_cleanup_failed'})
 for(const changed of [{...customer,metadata:{app:'cyntch',household_id:f.shared}},{...customer,livemode:true},{...customer,id:'cus_wrong'}]){
  f.customers.set(first.customerId,changed);await assert.rejects(f.cleanup(),{code:'stripe_cleanup_failed'})
 }
 f.customers.delete(first.customerId);await assert.rejects(f.cleanup(),{code:'stripe_cleanup_failed'})
 assert.equal(f.calls.some(call=>call[0]==='delete'),false,'404 or wrong environment is never acknowledged as erasure')
 f.customers.set(first.customerId,customer)
 await f.adapter(f.db,{...f.job,work:{...f.job.work,stripe:[{customerId:'cus_unrelated',householdId:f.shared}]}},f.provider)
 assert.equal(f.calls.some(call=>call[1]==='cus_unrelated'),false,'Caller-supplied work is ignored')
})

test('completed customer progress survives later provider failure and expired workers cannot acknowledge it',options,async t=>{
 const f=await setup(t),retrieve=f.provider.client.customers.retrieve,second=f.job.work.stripe[1].customerId
 f.provider.client.customers.retrieve=async(...args)=>{if(args[0]===second)throw Error('Provider unavailable');return retrieve(...args)}
 await assert.rejects(f.cleanup(),{code:'stripe_cleanup_failed'})
 let work=(await f.db.query('select work from account_deletion_requests where id=$1',[f.job.id])).rows[0].work
 assert.equal(work.stripe[0].completed,true);assert.equal(work.stripe[1].completed,undefined)
 f.provider.client.customers.retrieve=retrieve
 const del=f.provider.client.customers.del
 f.provider.client.customers.del=async(...args)=>{const result=await del(...args);await f.db.query("update account_deletion_requests set lease_until=now()-interval '1 second' where id=$1",[f.job.id]);return result}
 await assert.rejects(f.cleanup(),{code:'stripe_cleanup_failed'})
 work=(await f.db.query('select work from account_deletion_requests where id=$1',[f.job.id])).rows[0].work
 assert.equal(work.stripe[1].completed,undefined)
 f.job.leaseId=randomUUID();await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[f.job.id,f.job.leaseId])
 await f.cleanup();assert.equal(f.calls.filter(call=>call[0]==='delete').length,2)
})

test('a transferred household cannot open the old customer portal or buy before provider cleanup',options,async t=>{
 const f=await setup(t);f.identity.userId=f.successor
 let providerCalls=0
 const stripe={billingPortal:{sessions:{create:async()=>{providerCalls++;return {url:'https://billing.stripe.com/no'}}}}}
 const mocks={'@/lib/stripe-billing':{stripeClient:()=>stripe,billingOrigin:()=> 'https://cyntch.test'},'@/lib/usage-controls':{enforceRequestLimit:async()=>{}}}
 const portal=f.load(['app/api/billing/portal/route.ts'],mocks)
 const response=await portal.POST(new Request('https://cyntch.test/api/billing/portal',{method:'POST',headers:{origin:'https://cyntch.test','content-type':'application/json'},body:JSON.stringify({householdId:f.transfer})}))
 assert.equal(response.status,409);assert.equal(providerCalls,0)
 const native=f.load(['lib/native-billing-actions.ts','lib/native-billing-management.ts'],mocks)
 await assert.rejects(native.prepareWebBillingCancellation({...f.scope,accountId:f.successor,householdId:f.transfer}),{status:409})
 await assert.rejects(native.assertNoStripePurchase(f.transfer),{code:'purchase_in_progress'})
 await f.cleanup();await native.assertNoStripePurchase(f.transfer)
})

test('a new owner uses a fresh, retry-stable Stripe customer after the old paid period expires',options,async t=>{
 const f=await setup(t);await f.cleanup();f.identity.userId=f.successor
 await f.db.query("update household_billing set paid_through=now()-interval '1 second' where household_id=$1",[f.transfer])
 const keys=[];let failCheckout=true
 const stripe={customers:{create:async(_params,options)=>{keys.push(options.idempotencyKey);return {id:'cus_new_owner'}}},subscriptions:{list:async()=>({data:[],has_more:false})},
  checkout:{sessions:{list:async()=>({data:[],has_more:false}),create:async()=>{if(failCheckout)throw Error('Network interrupted');return {url:'https://checkout.stripe.test/new'}}}}}
 const prior=process.env.FREEMIUM_ENFORCEMENT_ENABLED;process.env.FREEMIUM_ENFORCEMENT_ENABLED='true';t.after(()=>{if(prior===undefined)delete process.env.FREEMIUM_ENFORCEMENT_ENABLED;else process.env.FREEMIUM_ENFORCEMENT_ENABLED=prior})
 const web=f.load(['app/api/billing/checkout/route.ts'],{'@/lib/stripe-billing':{stripeClient:()=>stripe,billingOrigin:()=> 'https://cyntch.test',validatedPrice:async()=>({id:'price_fixture'})},
  '@/lib/usage-controls':{enforceRequestLimit:async()=>{}},'@/lib/web-billing-reservation':{reserveWebBillingCheckout:async()=>null},'@/lib/billing-access':{nativeBillingEnvironment:()=>null,paidHouseholdAccessSql:()=> 'false'}})
 const request=()=>new Request('https://cyntch.test/api/billing/checkout',{method:'POST',headers:{origin:'https://cyntch.test','content-type':'application/json'},body:JSON.stringify({householdId:f.transfer,interval:'monthly'})})
 assert.equal((await web.POST(request())).status,503)
 const interrupted=(await f.db.query('select stripe_customer_id,stripe_customer_generation from household_billing where household_id=$1',[f.transfer])).rows[0]
 assert.deepEqual(interrupted,{stripe_customer_id:'cus_new_owner',stripe_customer_generation:1},'A lost checkout response must keep its customer discoverable for deletion')
 failCheckout=false;assert.equal((await web.POST(request())).status,200)
 assert.deepEqual(keys,[`cyntch-customer-${f.transfer}-1`],'Retry reuses the committed binding')
 const billing=(await f.db.query('select * from household_billing where household_id=$1',[f.transfer])).rows[0]
 assert.equal(billing.stripe_customer_id,'cus_new_owner');assert.equal(billing.stripe_customer_retired,false)
 assert.equal(billing.stripe_subscription_id,null);assert.equal(billing.stripe_customer_generation,1)
 assert.equal(billing.paid_through,null);assert.equal(billing.stripe_customer_deleted_at,null)
 await f.cleanup();assert.equal((await f.db.query('select stripe_customer_id from household_billing where household_id=$1',[f.transfer])).rows[0].stripe_customer_id,'cus_new_owner')
})

test('retired customer reconciliation retains verified paid access and respects a later refund hold',options,async t=>{
 const f=await setup(t);await f.cleanup()
 const original=(await f.db.query('select * from household_billing where household_id=$1',[f.transfer])).rows[0]
 const env={STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_MONTHLY_PRICE_ID:'price_monthly',STRIPE_YEARLY_PRICE_ID:'price_yearly'}
 const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env)
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}})
 const subscription={id:'sub_transfer',customer:'cus_transfer',status:'canceled',metadata:{household_id:f.transfer,app:'cyntch'},items:{data:[{price:{id:'price_monthly'},quantity:1}]},created:1,cancel_at_period_end:false,cancel_at:null}
 const stripe={subscriptions:{list:async()=>assert.fail('Do not list a deleted customer'),retrieve:async id=>{assert.equal(id,'sub_transfer');return subscription}},
  invoices:{list:async()=>({data:[]}),retrieve:async()=>({lines:{data:[{period:{end:original.paid_through.getTime()/1000+100}}]}})}}
 const lib=f.load(['lib/stripe-billing.ts','lib/billing-access.ts'],{stripe:class{constructor(){return stripe}}})
 await lib.reconcileHouseholdSubscription(f.transfer)
 const access=async()=>(await f.db.query(`select ${lib.paidHouseholdAccessSql('b.household_id','b',{NATIVE_BILLING_ENABLED:'false'})} as paid from household_billing b where household_id=$1`,[f.transfer])).rows[0].paid
 assert.equal(await access(),true)
 await f.db.query("update household_billing set billing_hold='refund:in_returned' where household_id=$1",[f.transfer])
 await lib.reconcileHouseholdSubscription(f.transfer);assert.equal(await access(),false)
 const after=(await f.db.query('select * from household_billing where household_id=$1',[f.transfer])).rows[0]
 assert.equal(after.billing_hold,'refund:in_returned');assert.deepEqual(after.paid_through,original.paid_through)
 subscription.customer='cus_unrelated';await assert.rejects(lib.reconcileHouseholdSubscription(f.transfer),{status:503})
 assert.equal(await access(),false)
})

test('subscription-only capture resolves its verified customer and a foreign binding prevents deletion',options,async t=>{
 const f=await setup(t),item=f.job.work.stripe[0],customer=f.customers.get(item.customerId)
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{stripe,0,customerId}','null') where id=$1`,[f.job.id])
 f.provider.client.subscriptions.retrieve=async id=>({id,customer:item.customerId,livemode:false,metadata:customer.metadata})
 await f.db.query('update household_billing set stripe_customer_id=null,stripe_subscription_id=null where household_id=$1',[item.householdId])
 await f.db.query('insert into household_billing(household_id,stripe_customer_id) values($1,$2)',[f.shared,item.customerId])
 await assert.rejects(f.cleanup(),{code:'stripe_cleanup_failed'});assert.equal(f.calls.length,0)
 await f.db.query('delete from household_billing where household_id=$1',[f.shared])
 await f.cleanup();assert.equal(f.calls.filter(call=>call[0]==='delete').length,2)
})

test('deletion after an interrupted checkout captures and closes its committed customer',options,async t=>{
 const f=await fixture(t);f.identity.userId=f.other
 const customer={object:'customer',id:'cus_interrupted_checkout',livemode:false,metadata:{app:'cyntch',household_id:f.shared}}
 const removed=[]
 const stripe={customers:{list:async()=>({object:'list',data:[customer],has_more:false}),create:async()=>customer,retrieve:async()=>customer,del:async id=>{removed.push(id);return {id,deleted:true}}},
  testHelpers:{testClocks:{list:async()=>({object:'list',data:[],has_more:false})}},
  subscriptions:{list:async()=>({data:[],has_more:false})},checkout:{sessions:{list:async()=>({data:[],has_more:false}),create:async()=>{throw Error('Lost checkout response')}}}}
 const mocks={'@/lib/stripe-billing':{stripeClient:()=>stripe,billingOrigin:()=> 'https://cyntch.test',validatedPrice:async()=>({id:'price_fixture'})},
  '@/lib/usage-controls':{enforceRequestLimit:async()=>{}},'@/lib/web-billing-reservation':{reserveWebBillingCheckout:async()=>null},'@/lib/billing-access':{nativeBillingEnvironment:()=>null,paidHouseholdAccessSql:()=> 'false'}}
 const prior=process.env.FREEMIUM_ENFORCEMENT_ENABLED;process.env.FREEMIUM_ENFORCEMENT_ENABLED='true';t.after(()=>{if(prior===undefined)delete process.env.FREEMIUM_ENFORCEMENT_ENABLED;else process.env.FREEMIUM_ENFORCEMENT_ENABLED=prior})
 const web=f.load(['app/api/billing/checkout/route.ts'],mocks)
 const result=await web.POST(new Request('https://cyntch.test/api/billing/checkout',{method:'POST',headers:{origin:'https://cyntch.test','content-type':'application/json'},body:JSON.stringify({householdId:f.shared,interval:'monthly'})}))
 assert.equal(result.status,503)
 const scope={...f.scope,accountId:f.other,deviceId:f.otherDevice},review=await f.lib.readAccountDeletionReview(scope,f.secret)
 const intent={operationId:randomUUID(),revision:review.revision,ownership:[{householdId:f.shared,action:'delete'}],confirmAccountDeletion:true,acknowledgeSubscriptions:true}
 await f.lib.acceptAccountDeletion(f.db,scope,f.secret,intent,true,async()=>{})
 const leaseId=randomUUID();await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[intent.operationId,leaseId])
 const work=(await f.db.query('select work from account_deletion_requests where id=$1',[intent.operationId])).rows[0].work
 assert.deepEqual(work.stripe.map(item=>item.customerId),[customer.id])
 const job={id:intent.operationId,accountId:f.other,leaseId,work};await f.lib.deleteAccountData(f.db,job)
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{phases,data}','true') where id=$1`,[job.id])
 await f.load(['lib/account-deletion-stripe.ts']).deleteAccountStripeData(f.db,job,{client:stripe,livemode:false})
 assert.deepEqual(removed,[customer.id])
})

test('Stripe inventory resumes from a saved page and cannot delete before pagination completes',options,async t=>{
 const f=await setup(t),orphan={object:'customer',id:'cus_orphan',livemode:false,metadata:{app:'cyntch',household_id:f.transfer},email:'PRIVATE_SCAN@example.invalid'}
 f.customers.set(orphan.id,orphan)
 const calls=[];let fail=true
 f.provider.client.customers.list=async params=>{
  calls.push(params.starting_after??null)
  if(!params.starting_after)return {object:'list',data:[orphan,{object:'customer',id:'cus_other',livemode:false,metadata:{app:'different'},email:'UNRELATED@example.invalid'}],has_more:true}
  assert.equal(params.starting_after,'cus_other');if(fail)throw Error('Provider unavailable')
  return {object:'list',data:[],has_more:false}
 }
 await assert.rejects(f.cleanup(),{code:'stripe_cleanup_failed'})
 let work=(await f.db.query('select work from account_deletion_requests where id=$1',[f.job.id])).rows[0].work
 assert.equal(work.stripeDiscovery.scans[0].cursor,'cus_other');assert.equal(work.stripeDiscovery.complete,false)
 assert.equal(work.stripe.filter(item=>item.customerId===orphan.id).length,1);assert.equal(f.calls.length,0)
 assert.equal(JSON.stringify(work).includes('PRIVATE_SCAN'),false);assert.equal(JSON.stringify(work).includes('UNRELATED'),false)
 fail=false;await f.cleanup()
 assert.deepEqual(calls,[null,'cus_other','cus_other']);assert.equal(f.calls.filter(call=>call[0]==='delete').length,3)
 work=(await f.db.query('select work from account_deletion_requests where id=$1',[f.job.id])).rows[0].work
 assert.equal(work.stripeDiscovery.finalized,true)
})

test('an owned household without a billing row is frozen while orphan customers are discovered',options,async t=>{
 const f=await setup(t,f=>f.db.query('delete from household_billing where household_id=any($1::uuid[])',[[f.transfer,f.deleting]]))
 assert.deepEqual(f.job.work.stripe,[])
 assert.deepEqual(new Set(f.job.work.stripeHouseholds.map(item=>item.householdId)),new Set([f.transfer,f.deleting]))
 const before=(await f.db.query('select * from household_billing where household_id=$1',[f.transfer])).rows[0]
 assert.equal(before.stripe_customer_retired,true);assert.equal(before.stripe_customer_deleted_at,null)
 for(const [id,hh,app]of [['cus_unbound',f.transfer,'cyntch'],['cus_member_only',f.shared,'cyntch'],['cus_foreign_app',f.transfer,'other']]){
  f.customers.set(id,{object:'customer',id,livemode:false,metadata:{app,household_id:hh}})
 }
 await f.cleanup()
 assert.deepEqual(f.calls.filter(call=>call[0]==='delete').map(call=>call[1]),['cus_unbound'])
 assert.ok((await f.db.query('select stripe_customer_deleted_at from household_billing where household_id=$1',[f.transfer])).rows[0].stripe_customer_deleted_at)
 assert.equal(f.customers.get('cus_member_only').deleted,undefined,'Membership alone is not ownership of its billing customer')
})

test('test-clock inventory is paginated and includes its separately listed customers',options,async t=>{
 const f=await setup(t),clockCalls=[],scans=[]
 const orphan={object:'customer',id:'cus_clock_orphan',livemode:false,metadata:{app:'cyntch',household_id:f.transfer}}
 f.customers.set(orphan.id,orphan)
 f.provider.client.testHelpers.testClocks.list=async params=>{
  clockCalls.push(params.starting_after??null)
  return {object:'list',data:[{object:'test_helpers.test_clock',id:params.starting_after?'clock_two':'clock_one',livemode:false}],has_more:!params.starting_after}
 }
 f.provider.client.customers.list=async params=>{scans.push(params.test_clock??null);return {object:'list',data:params.test_clock==='clock_two'?[orphan]:[],has_more:false}}
 await f.cleanup()
 assert.deepEqual(clockCalls,[null,'clock_one']);assert.deepEqual(scans,[null,'clock_one','clock_two'])
 assert.equal(f.calls.filter(call=>call[0]==='delete').length,3)
})

test('one undeleted orphan keeps purchases frozen and finalized retries cannot unlock a newer billing account',options,async t=>{
 const f=await setup(t),orphan={object:'customer',id:'cus_pending_orphan',livemode:false,metadata:{app:'cyntch',household_id:f.transfer}}
 f.customers.set(orphan.id,orphan)
 const retrieve=f.provider.client.customers.retrieve
 f.provider.client.customers.retrieve=async(...args)=>{if(args[0]===orphan.id)throw Error('Unavailable');return retrieve(...args)}
 await assert.rejects(f.cleanup(),{code:'stripe_cleanup_failed'})
 assert.equal(f.calls.filter(call=>call[0]==='delete').length,2)
 assert.equal((await f.db.query('select stripe_customer_deleted_at from household_billing where household_id=$1',[f.transfer])).rows[0].stripe_customer_deleted_at,null)
 await assert.rejects(f.load(['lib/native-billing-actions.ts']).assertNoStripePurchase(f.transfer),{code:'purchase_in_progress'})
 f.provider.client.customers.retrieve=retrieve;await f.cleanup()
 await f.db.query("update household_billing set stripe_customer_id='cus_new_owner',stripe_customer_deleted_at=null,stripe_customer_retired=true where household_id=$1",[f.transfer])
 await f.cleanup()
 assert.deepEqual((await f.db.query('select stripe_customer_id,stripe_customer_deleted_at from household_billing where household_id=$1',[f.transfer])).rows[0],{stripe_customer_id:'cus_new_owner',stripe_customer_deleted_at:null})
})

test('an expired worker cannot persist an inventory page or start customer deletion',options,async t=>{
 const f=await setup(t),list=f.provider.client.customers.list
 f.provider.client.customers.list=async(...args)=>{
  const result=await list(...args);await f.db.query("update account_deletion_requests set lease_until=now()-interval '1 second' where id=$1",[f.job.id]);return result
 }
 await assert.rejects(f.cleanup(),{code:'stripe_cleanup_failed'});assert.equal(f.calls.length,0)
 const work=(await f.db.query('select work from account_deletion_requests where id=$1',[f.job.id])).rows[0].work
 assert.equal(work.stripeDiscovery.scans[0].cursor,null);assert.equal(work.stripeDiscovery.complete,false)
 f.provider.client.customers.list=list;f.job.leaseId=randomUUID()
 await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[f.job.id,f.job.leaseId])
 await f.cleanup();assert.equal(f.calls.filter(call=>call[0]==='delete').length,2)
})

test('malformed or wrong-environment inventories never count as an empty billing account',options,async t=>{
 const f=await setup(t)
 for(const page of [{object:'list',data:[]},{object:'list',data:[],has_more:true},
  {object:'list',data:[{object:'customer',id:'cus_wrong_mode',livemode:true,metadata:{}}],has_more:false}]) {
  f.provider.client.customers.list=async()=>page;await assert.rejects(f.cleanup(),{code:'stripe_cleanup_failed'})
 }
 assert.equal(f.calls.length,0)
 assert.equal((await f.db.query('select stripe_customer_deleted_at from household_billing where household_id=$1',[f.transfer])).rows[0].stripe_customer_deleted_at,null)
})

test('an account with no owned households completes Stripe cleanup without provider configuration',options,async t=>{
 const f=await fixture(t),accountId='user_empty_'+randomUUID(),scope={...f.scope,accountId,deviceId:randomUUID()}
 await f.db.query('insert into users(id) values($1)',[accountId])
 const review=await f.lib.readAccountDeletionReview(scope,f.secret),intent={operationId:randomUUID(),revision:review.revision,ownership:[],confirmAccountDeletion:true,acknowledgeSubscriptions:true}
 await f.lib.acceptAccountDeletion(f.db,scope,f.secret,intent,true,async()=>{})
 const leaseId=randomUUID();await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[intent.operationId,leaseId])
 const work=(await f.db.query('select work from account_deletion_requests where id=$1',[intent.operationId])).rows[0].work
 const job={id:intent.operationId,accountId,leaseId,work};await f.lib.deleteAccountData(f.db,job)
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{phases,data}','true') where id=$1`,[job.id])
 const lib=f.load(['lib/account-deletion-stripe.ts'],{'@/lib/stripe-billing':{stripeClient:()=>assert.fail('No owned billing scope requires no provider access')}})
 await lib.deleteAccountStripeData(f.db,job)
 assert.equal((await f.db.query('select work from account_deletion_requests where id=$1',[job.id])).rows[0].work.stripeDiscovery.finalized,true)
 assert.equal((await f.db.query('select stripe_customer_retired from household_billing where household_id=$1',[f.transfer])).rows[0].stripe_customer_retired,false)
})

test('inventory checkpoints yield when their invocation budget ends and resume without losing the saved cursor',options,async t=>{
 const f=await setup(t),first=f.job.work.stripe[0].customerId
 let now=0
 f.provider.client.customers.list=async params=>{
  now=100
  return {object:'list',data:params.starting_after?[...f.customers.values()].filter(item=>item.id!==first):[f.customers.get(first)],has_more:!params.starting_after}
 }
 await assert.rejects(f.adapter(f.db,f.job,f.provider,50,()=>now),{code:'cleanup_pending',retryAfterSeconds:1})
 assert.equal(f.calls.length,0)
 const work=(await f.db.query('select work from account_deletion_requests where id=$1',[f.job.id])).rows[0].work
 assert.equal(work.stripeDiscovery.scans[0].cursor,first);assert.equal(work.stripeDiscovery.complete,false)
 await f.cleanup();assert.equal(f.calls.filter(call=>call[0]==='delete').length,2)
})
