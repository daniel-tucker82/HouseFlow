/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL deletion lifecycle; RevenueCat transport is a provider double. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),options={skip:!connectionString}
const missing=()=>Response.json({object:'error',type:'resource_missing',message:'Resource not found',retryable:false},{status:404})
const list=(items=[],next_page=null)=>({object:'list',items,next_page})

async function setup(t,beforeAccept=async()=>{}) {
 const f=await fixture(t);await beforeAccept(f)
 const intent=await f.intent();await f.accept(intent)
 const leaseId=randomUUID()
 await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[intent.operationId,leaseId])
 const job={id:intent.operationId,accountId:f.owner,leaseId,work:(await f.db.query('select work from account_deletion_requests where id=$1',[intent.operationId])).rows[0].work}
 await f.lib.deleteAccountData(f.db,job)
 await f.db.query(`update account_deletion_requests set work=jsonb_set(jsonb_set(work,'{phases,data}','true'),'{phases,stripe}','true') where id=$1`,[job.id])
 const calls=[],customers=new Map(job.work.retiredNativeAccounts.map(item=>[item.id,{object:'customer',id:item.id,project_id:item.projectId}]))
 const state={aliases:list([{object:'customer.alias',id:f.native}]),subscriptions:list([{object:'subscription',id:'sub_native',customer_id:f.native,original_customer_id:f.native,environment:'sandbox',store:'play_store',ownership:'purchased'}]),purchases:list(),onRequest:null,eraseImmediately:false}
 const provider={projectId:'proj_fixture',secret:'secret-test-only',fetcher:async(url,init)=>{
  url=new URL(url);calls.push({url:url.href,method:init.method,signal:init.signal})
  assert.equal(init.headers.Authorization,'Bearer secret-test-only');assert.equal(init.cache,'no-store');assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal)
  if(state.onRequest){const response=await state.onRequest(url,init);if(response)return response}
  const parts=url.pathname.split('/'),id=parts[5],resource=parts[6]
  if(!id)return Response.json(list([...customers.values()].slice(0,1)))
  if(!customers.has(id))return missing()
  if(resource)return Response.json(state[resource])
  if(init.method==='DELETE'){if(state.eraseImmediately)customers.delete(id);return Response.json({object:'customer',id,deleted_at:Date.now()})}
  return Response.json(customers.get(id))
 }}
 const lib=f.load(['lib/account-deletion-native.ts','lib/account-deletion-processing.ts'])
 const read=async()=>(await f.db.query('select * from account_deletion_requests where id=$1',[job.id])).rows[0]
 return {...f,job,calls,customers,state,provider,read,adapter:lib.deleteAccountNativeData,process:lib.processAccountDeletions,
  cleanup:()=>lib.deleteAccountNativeData(f.db,job,provider),deletes:()=>calls.filter(call=>call.method==='DELETE')}
}

test('native erasure waits for confirmed absence and retains local purchase bindings and shared households',options,async t=>{
 let sharedNative
 const f=await setup(t,async f=>{sharedNative=randomUUID();await f.db.query("insert into native_billing_accounts(id,household_id,project_id,environment) values($1,$2,'proj_fixture','sandbox')",[sharedNative,f.transfer])})
 const before=(await f.db.query('select * from native_subscriptions')).rows
 await assert.rejects(f.cleanup(),{code:'cleanup_pending',retryAfterSeconds:5})
 let row=await f.read();assert.ok(row.work.retiredNativeAccounts[0].requestedAt);assert.equal(row.work.retiredNativeAccounts[0].completed,undefined)
 assert.equal(row.work.phases.native,false);assert.equal(f.deletes().length,1)
 await assert.rejects(f.cleanup(),{code:'cleanup_pending'});assert.equal(f.deletes().length,1,'Poll pending work without repeating DELETE')
 f.customers.delete(f.native);await f.cleanup()
 row=await f.read();assert.equal(row.work.retiredNativeAccounts[0].completed,true);assert.equal(row.work.phases.native,false,'Coordinator owns phase acknowledgement')
 const count=f.calls.length;await f.cleanup();assert.equal(f.calls.length,count,'Durable checkpoint skips confirmed customer')
 assert.equal(f.calls.some(call=>call.url.includes(sharedNative)),false)
 assert.deepEqual((await f.db.query('select * from native_subscriptions')).rows,before)
 assert.equal((await f.db.query('select household_id from native_billing_accounts where id=$1',[sharedNative])).rows[0].household_id,f.transfer)
 assert.ok(f.calls.every(call=>call.url.startsWith('https://api.revenuecat.com/v2/')))
 assert.equal(f.calls.some(call=>call.url.includes('environment=')),false,'Deletion affects both environments, so inspect both')
})

test('lost native DELETE response recovers through verified absence without another DELETE',options,async t=>{
 const f=await setup(t);f.state.onRequest=async(url,init)=>{if(init.method==='DELETE'){f.customers.delete(f.native);throw Error('private API key and identifier')}}
 await assert.rejects(f.cleanup(),{code:'native_cleanup_failed',message:'native_cleanup_failed'})
 assert.equal((await f.read()).work.retiredNativeAccounts[0].completed,undefined)
 await f.cleanup();assert.equal(f.deletes().length,1);assert.equal((await f.read()).work.retiredNativeAccounts[0].completed,true)
})

test('native cleanup verifies project access before interpreting customer absence',options,async t=>{
 const f=await setup(t);f.customers.clear()
 for(const response of [()=>missing(),()=>Response.json({object:'error'},{status:403}),()=>Response.json(list([{object:'customer',id:'other',project_id:'wrong'}]))]){
  f.state.onRequest=async url=>url.pathname.endsWith('/customers')?response():null
  await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'});assert.equal((await f.read()).work.retiredNativeAccounts[0].completed,undefined)
 }
 f.state.onRequest=null;await f.cleanup();assert.equal((await f.read()).work.retiredNativeAccounts[0].completed,true)
 assert.equal(f.deletes().length,0)
})

test('proxy and unrelated resource errors cannot acknowledge native erasure',options,async t=>{
 const f=await setup(t)
 for(const response of [()=>new Response('Not found',{status:404}),()=>Response.json({object:'error',type:'authentication_error'},{status:404}),()=>Response.json({object:'error',type:'resource_missing',param:'project_id'},{status:404}),()=>Response.json({object:'error',type:'resource_missing'},{status:503})]){
  f.state.onRequest=async url=>url.pathname.endsWith(f.native)?response():null
  await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'});assert.equal((await f.read()).work.retiredNativeAccounts[0].completed,undefined)
 }
 assert.equal(f.deletes().length,0)
})

test('native erasure rejects foreign aliases, canonical identities, environments, stores and purchase ownership',options,async t=>{
 const f=await setup(t),original=f.customers.get(f.native),subscription=f.state.subscriptions.items[0]
 for(const changed of [{...original,id:randomUUID()},{...original,project_id:'different'}]){f.customers.set(f.native,changed);await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'})}
 f.customers.set(f.native,original)
 f.state.aliases=list([{object:'customer.alias',id:randomUUID()}]);await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'});f.state.aliases=list()
 for(const changed of [{...subscription,environment:'production'},{...subscription,customer_id:randomUUID()},{...subscription,original_customer_id:randomUUID()},{...subscription,store:'rc_billing'},{...subscription,ownership:'family_shared'}]){
  f.state.subscriptions=list([changed]);await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'})
 }
 f.state.subscriptions=list([subscription]);f.state.purchases=list([{...subscription,object:'purchase',id:'purchase_foreign',store:'stripe'}])
 await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'});assert.equal(f.deletes().length,0)
})

test('all native ownership pages are checked and foreign pagination never receives credentials',options,async t=>{
 const f=await setup(t),path=`/v2/projects/proj_fixture/customers/${f.native}/subscriptions`
 for(const next of ['https://attacker.test/steal',`${path}?environment=sandbox`,`${path}?starting_after=x#fragment`,`${path}/../aliases?starting_after=x`]){
  f.state.subscriptions=list([],next);await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'})
 }
 f.state.subscriptions=list([],`${path}?starting_after=second`)
 f.state.onRequest=async url=>url.searchParams.get('starting_after')==='second'?Response.json(list([{object:'subscription',id:'foreign',customer_id:randomUUID(),original_customer_id:f.native,environment:'sandbox',store:'play_store',ownership:'purchased'}])):null
 await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'})
 assert.equal(f.deletes().length,0);assert.ok(f.calls.every(call=>new URL(call.url).origin==='https://api.revenuecat.com'))
 assert.ok(f.calls.some(call=>call.url.includes('starting_after=second')))
})

test('native cleanup uses durable scope and refuses an expired lease or newly live local identity',options,async t=>{
 const f=await setup(t)
 for(const job of [{...f.job,accountId:f.other},{...f.job,leaseId:randomUUID()}])await assert.rejects(f.adapter(f.db,job,f.provider),{code:'native_cleanup_failed'})
 assert.equal(f.calls.length,0)
 await f.db.query('update native_billing_accounts set household_id=$2 where id=$1',[f.native,f.shared])
 await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'});assert.equal(f.deletes().length,0)
 await f.db.query('update native_billing_accounts set household_id=null where id=$1',[f.native])
 await assert.rejects(f.adapter(f.db,{...f.job,work:{...f.job.work,retiredNativeAccounts:[{id:randomUUID(),projectId:'foreign',environment:'production'}]}},f.provider),{code:'cleanup_pending'})
 assert.equal(f.deletes().length,1);assert.ok(f.deletes()[0].url.endsWith(f.native),'Caller work cannot expand saved scope')
})

test('native erasure rechecks local binding immediately before destructive provider request',options,async t=>{
 const f=await setup(t)
 f.state.onRequest=async url=>{if(url.pathname.endsWith('/purchases'))await f.db.query('update native_billing_accounts set household_id=$2 where id=$1',[f.native,f.shared])}
 await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'});assert.equal(f.deletes().length,0)
})

test('an expired worker cannot save native deletion progress after the provider accepts it',options,async t=>{
 const f=await setup(t)
 f.state.onRequest=async(url,init)=>{if(init.method==='DELETE'){f.customers.clear();await f.db.query("update account_deletion_requests set lease_until=now()-interval '1 second'")}}
 await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'});assert.equal((await f.read()).work.retiredNativeAccounts[0].requestedAt,undefined)
 f.job.leaseId=randomUUID();await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[f.job.id,f.job.leaseId])
 await f.cleanup();assert.equal((await f.read()).work.retiredNativeAccounts[0].completed,true);assert.equal(f.deletes().length,1)
})

test('the coordinator persists native provider waits and completes only after absence is verified',options,async t=>{
 const f=await setup(t);await f.db.query('update account_deletion_requests set lease_id=null,lease_until=null')
 let identityCalls=0
 const adapters={data:async()=>assert.fail('already completed'),stripe:async()=>assert.fail('already completed'),native:job=>f.adapter(f.db,job,f.provider),identity:async()=>{identityCalls++}}
 assert.deepEqual(await f.process(f.db,adapters,1),{claimed:1,completed:0,retrying:1,interrupted:0})
 let row=await f.read();assert.equal(row.work.phases.native,false);assert.equal(row.attempts,0);assert.equal(row.last_error_code,null);assert.ok(row.next_attempt_at);assert.equal(row.lease_id,null);assert.equal(identityCalls,0)
 assert.equal((await f.process(f.db,adapters,1)).claimed,0)
 f.customers.clear();await f.db.query("update account_deletion_requests set next_attempt_at=now()-interval '1 second'")
 assert.equal((await f.process(f.db,adapters,1)).completed,1);assert.equal(identityCalls,1)
 row=await f.read();assert.equal(row.account_id,null);assert.deepEqual(row.work,{})
})

test('native pending deletion is revalidated and reissued after a durable delay',options,async t=>{
 const f=await setup(t);await assert.rejects(f.cleanup(),{code:'cleanup_pending'})
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{retiredNativeAccounts,0,requestedAt}',to_jsonb((now()-interval '6 minutes')::text))`)
 f.state.aliases=list([{object:'customer.alias',id:randomUUID()}]);await assert.rejects(f.cleanup(),{code:'native_cleanup_failed'});assert.equal(f.deletes().length,1)
 f.state.aliases=list();await assert.rejects(f.cleanup(),{code:'cleanup_pending'});assert.equal(f.deletes().length,2)
})

test('native erasure needs no provider configuration when no captured native identity exists',options,async t=>{
 const f=await setup(t,async f=>{await f.db.query('delete from native_subscriptions');await f.db.query('delete from native_billing_accounts')})
 await f.adapter(f.db,f.job,{projectId:'',secret:'',fetcher:async()=>assert.fail('No provider work')});assert.equal(f.calls.length,0)
})

test('native cleanup configuration remains usable while purchasing is disabled',options,async t=>{
 const f=await setup(t),keys=['REVENUECAT_PROJECT_ID','REVENUECAT_V2_SECRET_KEY','REVENUECAT_V1_SECRET_KEY','REVENUECAT_NATIVE_PRODUCTS','NATIVE_BILLING_ENABLED'],before=Object.fromEntries(keys.map(key=>[key,process.env[key]])),originalFetch=global.fetch
 t.after(()=>{global.fetch=originalFetch;for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key]})
 for(const key of keys)delete process.env[key]
 process.env.REVENUECAT_PROJECT_ID='proj_fixture';process.env.REVENUECAT_V2_SECRET_KEY='secret-test-only';process.env.NATIVE_BILLING_ENABLED='false';global.fetch=f.provider.fetcher
 await assert.rejects(f.adapter(f.db,f.job),{code:'cleanup_pending'});assert.equal(f.deletes().length,1)
})

test('native cleanup budget exhaustion preserves each verified customer checkpoint',options,async t=>{
 let second
 const f=await setup(t,async f=>{second=randomUUID();await f.db.query("insert into native_billing_accounts(id,household_id,project_id,environment) values($1,$2,'proj_fixture','production')",[second,f.deleting])})
 f.customers.clear();let clock=0,reads=0
 f.state.onRequest=async url=>{if(!url.pathname.endsWith('/customers')){reads++;clock=20}}
 await assert.rejects(f.adapter(f.db,f.job,f.provider,20,()=>clock),{code:'cleanup_pending',retryAfterSeconds:1})
 assert.equal(reads,1);assert.equal((await f.read()).work.retiredNativeAccounts.filter(item=>item.completed).length,1)
 f.state.onRequest=null;await f.cleanup();assert.ok((await f.read()).work.retiredNativeAccounts.every(item=>item.completed))
})

test('malformed native DELETE acknowledgement never marks erasure complete and does not persist provider details',options,async t=>{
 const f=await setup(t)
 for(const body of [{object:'customer',id:'foreign',deleted_at:Date.now()},{object:'customer',id:f.native},{object:'error',secret:'private-token'}]){
  f.state.onRequest=async(url,init)=>init.method==='DELETE'?Response.json(body):null
  await assert.rejects(f.cleanup(),{code:'native_cleanup_failed',message:'native_cleanup_failed'})
  const row=await f.read();assert.equal(row.work.retiredNativeAccounts[0].completed,undefined);assert.equal(JSON.stringify(row.work).includes('private-token'),false)
 }
})

test('native provider requests are aborted within the invocation budget without acknowledging cleanup',options,async t=>{
 const f=await setup(t);let observedAbort=false
 const provider={...f.provider,fetcher:async(url,init)=>new Promise((_resolve,reject)=>{
  const abort=()=>{observedAbort=true;reject(init.signal.reason)}
  if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true})
 })}
 // Fixed bookkeeping clock makes the actual AbortSignal timer the subject of
 // this check, independently of database scheduling on a busy test machine.
 await assert.rejects(f.adapter(f.db,f.job,provider,15,()=>0),{code:'native_cleanup_failed'})
 assert.equal(observedAbort,true);assert.equal((await f.read()).work.retiredNativeAccounts[0].completed,undefined)
})
