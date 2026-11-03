/* eslint-disable @typescript-eslint/no-require-imports -- Isolated real PostgreSQL lifecycle with explicit Clerk transport doubles. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),options={skip:!connectionString}
const absent=()=>Response.json({errors:[{code:'resource_not_found',message:'Not found',long_message:'Resource not found'}]},{status:404})
async function setup(t){
 const f=await fixture(t),intent=await f.intent();await f.accept(intent)
 const job={id:intent.operationId,accountId:f.owner,leaseId:randomUUID(),work:{}}
 await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[job.id,job.leaseId])
 await f.lib.deleteAccountData(f.db,job)
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{phases}','{"data":true,"stripe":true,"native":true,"identity":false}')`)
 const calls=[],state={instance:{object:'instance',id:'ins_fixture',environment_type:'development'},domains:{data:[{object:'domain',frontend_api_url:'https://fixture.clerk.accounts.dev'}],total_count:1},user:{object:'user',id:f.owner,external_accounts:[{provider:'oauth_google',id:'external_fixture'}]},onRequest:null}
 const provider={secretKey:'sk_test_fixture',fetcher:async(input,init)=>{
  const url=new URL(input);calls.push({path:url.pathname,method:init.method})
  assert.equal(url.origin,'https://api.clerk.com');assert.equal(init.headers.Authorization,'Bearer sk_test_fixture');assert.equal(init.headers['Clerk-API-Version'],'2026-08-20');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.ok(init.signal instanceof AbortSignal)
  if(state.onRequest){const result=await state.onRequest(url,init);if(result)return result}
  if(url.pathname==='/v1/instance')return Response.json(state.instance)
  if(url.pathname==='/v1/domains')return Response.json(state.domains)
  assert.equal(url.pathname,`/v1/users/${f.owner}`)
  if(!state.user)return absent()
  if(init.method==='DELETE'){state.user=null;return Response.json({object:'user',id:f.owner,deleted:true})}
  return Response.json(state.user)
 }}
 const lib=f.load(['lib/account-deletion-identity.ts','lib/account-deletion-processing.ts'])
 return {...f,job,calls,state,provider,lib,read:async()=>(await f.db.query('select * from account_deletion_requests where id=$1',[job.id])).rows[0],cleanup:()=>lib.deleteAccountIdentity(f.db,job,provider),deletes:()=>calls.filter(call=>call.method==='DELETE')}
}

test('identity deletion binds the verified session issuer to Clerk and confirms user absence',options,async t=>{
 const f=await setup(t);await f.cleanup()
 const row=await f.read();assert.deepEqual(row.work.identity,{issuer:'https://fixture.clerk.accounts.dev',instanceId:'ins_fixture',environment:'development',completed:true})
 assert.equal(row.work.phases.identity,false,'Only coordinator acknowledges whole phase');assert.equal(f.deletes().length,1)
 assert.deepEqual(f.calls.map(call=>call.method),['GET','GET','GET','DELETE','GET'])
 const count=f.calls.length;await f.cleanup();assert.equal(f.calls.length,count)
 assert.ok((await f.db.query('select 1 from users where id=$1',[f.successor])).rowCount)
})

test('identity cleanup recovers a lost DELETE response and survives a later domain change within the pinned instance',options,async t=>{
 const f=await setup(t)
 f.state.onRequest=async(url,init)=>{if(init.method==='DELETE'){f.state.user=null;throw Error('private token hidden')}}
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed',message:'identity_cleanup_failed'});assert.equal((await f.read()).work.identity.completed,undefined)
 f.state.onRequest=null;f.state.domains={data:[],total_count:0}
 await f.cleanup();assert.equal(f.deletes().length,1);assert.equal((await f.read()).work.identity.completed,true,'Pinned instance still works after domain change')
 assert.equal(f.calls.filter(call=>call.path==='/v1/domains').length,1)
})

test('a missing user is not proof of deletion with a foreign issuer or instance',options,async t=>{
 const f=await setup(t);f.state.user=null
 f.state.domains={data:[{object:'domain',frontend_api_url:'https://foreign.clerk.accounts.dev'}],total_count:1}
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});assert.equal((await f.read()).work.identity.completed,undefined)
 assert.equal(f.calls.some(call=>call.path.includes('/users/')),false)
 f.state.domains={data:[{object:'domain',frontend_api_url:'https://fixture.clerk.accounts.dev'}],total_count:1}
 f.state.onRequest=async url=>{if(url.pathname.includes('/users/'))throw Error('interrupted')}
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'})
 f.state.instance.id='ins_another';f.state.onRequest=null
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});assert.equal((await f.read()).work.identity.completed,undefined)
 assert.equal(f.deletes().length,0)
})

test('identity cleanup rejects instance environment mismatch, provider failures and noncanonical 404 responses',options,async t=>{
 const f=await setup(t);f.state.instance.environment_type='production'
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});f.state.instance.environment_type='development'
 for(const result of [()=>new Response('proxy not found',{status:404}),()=>Response.json({errors:[{code:'authentication_invalid'}]},{status:404}),()=>Response.json({errors:[{code:'resource_not_found'}]},{status:503})]){
  f.state.onRequest=async url=>url.pathname.includes('/users/')?result():null
  await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'})
 }
 assert.equal(f.deletes().length,0);assert.equal((await f.read()).work.identity.completed,undefined)
})

test('identity erasure rejects malformed linked Apple account data before deleting the identity',options,async t=>{
 const f=await setup(t);f.state.user.external_accounts=[{provider:'oauth_apple',id:'external_apple'}]
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});assert.equal(f.deletes().length,0);assert.equal((await f.read()).work.identity.completed,undefined)
})

test('identity cleanup validates user identity, saved scope, preceding phases and lease before external mutation',options,async t=>{
 const f=await setup(t)
 for(const job of [{...f.job,accountId:f.other},{...f.job,leaseId:randomUUID()}])await assert.rejects(f.lib.deleteAccountIdentity(f.db,job,f.provider),{code:'identity_cleanup_failed'})
 assert.equal(f.calls.length,0)
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{phases,native}','false')`)
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});assert.equal(f.calls.length,0)
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{phases,native}','true')`)
 f.state.user.id=f.other;await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});assert.equal(f.deletes().length,0)
 f.state.user.id=f.owner;await f.lib.deleteAccountIdentity(f.db,{...f.job,work:{identity:{issuer:'https://attacker.test'}}},f.provider)
 assert.equal((await f.read()).work.identity.completed,true,'Caller-supplied work cannot override stored issuer')
})

test('an expired worker cannot acknowledge identity deletion after the provider accepts it',options,async t=>{
 const f=await setup(t)
 f.state.onRequest=async(url,init)=>{if(init.method==='DELETE')await f.db.query("update account_deletion_requests set lease_until=now()-interval '1 second'")}
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});assert.equal((await f.read()).work.identity.completed,undefined)
 f.job.leaseId=randomUUID();await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[f.job.id,f.job.leaseId])
 await f.cleanup();assert.equal((await f.read()).work.identity.completed,true);assert.equal(f.deletes().length,1)
})

test('identity propagation waits are durable and the coordinator clears identifiers only after verified absence',options,async t=>{
 const f=await setup(t);await f.db.query('update account_deletion_requests set lease_id=null,lease_until=null')
 f.state.onRequest=async(url,init)=>init.method==='DELETE'?Response.json({object:'user',id:f.owner,deleted:true}):null
 const adapters={data:async()=>assert.fail('completed'),stripe:async()=>assert.fail('completed'),native:async()=>assert.fail('completed'),identity:job=>f.lib.deleteAccountIdentity(f.db,job,f.provider)}
 assert.equal((await f.lib.processAccountDeletions(f.db,adapters,1)).retrying,1)
 let row=await f.read();assert.equal(row.work.phases.identity,false);assert.equal(row.last_error_code,null);assert.equal(row.attempts,0);assert.equal(row.lease_id,null)
 f.state.user=null;await f.db.query("update account_deletion_requests set next_attempt_at=now()-interval '1 second'")
 assert.equal((await f.lib.processAccountDeletions(f.db,adapters,1)).completed,1)
 row=await f.read();assert.equal(row.account_id,null);assert.deepEqual(row.work,{})
})

test('identity acceptance requires a valid verified issuer and stores it independently of client input',options,async t=>{
 const f=await fixture(t),intent=await f.intent()
 for(const issuer of ['','http://fixture.clerk.accounts.dev','https://user@fixture.clerk.accounts.dev','https://fixture.clerk.accounts.dev/path','https://fixture.clerk.accounts.dev?key=value'])await assert.rejects(f.accept(intent,{issuer}),{status:401})
 assert.equal((await f.db.query('select count(*)::int as n from account_deletion_requests')).rows[0].n,0)
 await f.accept(intent,{issuer:'https://fixture.clerk.accounts.dev/'})
 assert.equal((await f.db.query('select work from account_deletion_requests')).rows[0].work.identity.issuer,'https://fixture.clerk.accounts.dev')
})

test('identity requests respect invocation budget and abort a stuck provider',options,async t=>{
 const f=await setup(t);let time=0
 f.state.onRequest=async()=>{time=20}
 await assert.rejects(f.lib.deleteAccountIdentity(f.db,f.job,f.provider,20,()=>time),{code:'cleanup_pending',retryAfterSeconds:1})
 assert.equal(f.deletes().length,0)
 let aborted=false
 await assert.rejects(f.lib.deleteAccountIdentity(f.db,f.job,{secretKey:'sk_test_fixture',fetcher:async(url,init)=>new Promise((_resolve,reject)=>{
  const abort=()=>{aborted=true;reject(init.signal.reason)};if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true})
 })},10,()=>0),{code:'identity_cleanup_failed'})
 assert.equal(aborted,true);assert.equal((await f.read()).work.identity.completed,undefined)
})
