/* eslint-disable @typescript-eslint/no-require-imports -- Explicit opt-in development-provider verification; deletes only its own marked fixture. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')

test('Clerk development defaults prevent direct self-deletion while durable server deletion recovers a lost response',{
 skip:process.env.CYNTCH_CLERK_DELETION_TEST!=='true',timeout:90_000,
},async t=>{
 require('@next/env').loadEnvConfig(process.cwd(),true,{info(){},error(){}})
 const secretKey=process.env.CLERK_SECRET_KEY
 assert.match(secretKey??'',/^sk_test_\S+$/,'Only development Clerk credentials are allowed')
 const {fixture,connectionString}=require('../helpers/account-deletion.cjs')
 const database=new URL(connectionString)
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(database.hostname)&&database.pathname==='/cyntch_mobile_test')
 const headers={Authorization:`Bearer ${secretKey}`,'Clerk-API-Version':'2026-08-20',Accept:'application/json'}
 const request=async(endpoint,method='GET',body)=>{
  const response=await fetch(`https://api.clerk.com/v1${endpoint}`,{method,headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,
   redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)})
  return {status:response.status,body:await response.json()}
 }
 const instance=await request('/instance');assert.equal(instance.status,200);assert.equal(instance.body.environment_type,'development');assert.equal(instance.body.object,'instance')
 const domains=await request('/domains');assert.equal(domains.status,200)
 const domain=domains.body.data.find(item=>!item.is_satellite);assert.ok(domain)
 const nonce=randomUUID(),marker=`cyntch-delete-${nonce}`,evidencePath=path.join(os.tmpdir(),`${marker}.json`)
 const evidence={instanceId:instance.body.id,environment:'development',marker,createdUserId:null,verified:false,cleaned:false,defaultSelfDeletionDisabled:false,existingSessionPolicyEnforced:false,directSelfDeletionRejected:false,profileUpdateAllowed:false,lostDeleteResponseRecovered:false}
 const save=()=>fs.writeFileSync(evidencePath,JSON.stringify(evidence,null,2))
 save()
 // Recovery also handles a lost create response: match our unique external
 // marker AND private metadata before considering any identity for cleanup.
 t.after(async()=>{
  const current=await request('/instance');assert.equal(current.body.id,instance.body.id);assert.equal(current.body.environment_type,'development')
  const users=await request(`/users?external_id=${encodeURIComponent(marker)}&limit=2`);assert.equal(users.status,200);assert.ok(Array.isArray(users.body))
  for(const user of users.body){
   assert.equal(user.external_id,marker);assert.equal(user.private_metadata?.cyntch_deletion_test,nonce)
   const deleted=await request(`/users/${encodeURIComponent(user.id)}`,'DELETE');assert.ok([200,404].includes(deleted.status))
  }
  const remaining=await request(`/users?external_id=${encodeURIComponent(marker)}&limit=2`);assert.equal(remaining.status,200);assert.deepEqual(remaining.body,[])
  evidence.cleaned=true;save();console.log(`Clerk development evidence: ${evidencePath}`)
 })
 // Deliberately omit delete_self_enabled: a per-user override would hide an
 // unsafe instance default and leave new sign-ups able to bypass Cyntch review.
 const created=await request('/users','POST',{external_id:marker,email_address:[`${marker}+clerk_test@example.com`],password:`${randomBytes(24).toString('base64url')}aA7!`,
  first_name:'Cyntch deletion test',private_metadata:{cyntch_deletion_test:nonce}})
 assert.equal(created.status,200,`Development fixture creation failed (${created.status}; ${created.body.errors?.map(error=>error.code).join(',')??'unknown'})`)
 const user=created.body;assert.equal(user.object,'user');assert.equal(user.external_id,marker);assert.equal(user.private_metadata.cyntch_deletion_test,nonce)
 evidence.createdUserId=user.id;save()
 assert.equal(user.delete_self_enabled,false,'Disable direct self-deletion in the development instance User model settings before running this check')
 const persisted=await request(`/users/${encodeURIComponent(user.id)}`);assert.equal(persisted.status,200)
 assert.equal(persisted.body.delete_self_enabled,false,'New users must inherit the saved provider policy')
 evidence.defaultSelfDeletionDisabled=true;save()
 // Authenticate only our marked disposable identity through the same native
 // Frontend API paths used by Clerk Android. Never expose tickets/device tokens
 // in evidence or forward the backend credential to the frontend origin.
 const frontend=new URL(domain.frontend_api_url)
 assert.equal(frontend.protocol,'https:');assert.ok(frontend.hostname.endsWith('.clerk.accounts.dev'))
 const ticket=await request('/sign_in_tokens','POST',{user_id:user.id,expires_in_seconds:60})
 assert.equal(ticket.status,200);assert.equal(ticket.body.user_id,user.id);assert.equal(typeof ticket.body.token,'string')
 let deviceToken=null
 const nativeRequest=async(endpoint,method='GET',body)=>{
  const url=new URL(`/v1${endpoint}`,frontend);url.searchParams.set('_is_native','true')
  const response=await fetch(url,{method,headers:{Accept:'application/json','Clerk-API-Version':'2026-08-20',...(deviceToken?{Authorization:deviceToken}:{}),...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},
   body:body?new URLSearchParams(body):undefined,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)})
  deviceToken=response.headers.get('Authorization')??deviceToken
  return {status:response.status,body:await response.json()}
 }
 const signedIn=await nativeRequest('/client/sign_ins','POST',{strategy:'ticket',ticket:ticket.body.token})
 assert.equal(signedIn.status,200,`Fixture sign-in failed (${signedIn.status}; ${signedIn.body.errors?.map(error=>error.code).join(',')??'unknown'})`)
 assert.equal(signedIn.body.response?.status,'complete');assert.ok(deviceToken)
 const sessionId=signedIn.body.response.created_session_id;assert.match(sessionId,/^sess_/)
 const me=`/me?_clerk_session_id=${encodeURIComponent(sessionId)}`
 const current=await nativeRequest(me);assert.equal(current.status,200);assert.equal(current.body.response?.id,user.id)
 assert.equal(current.body.response.delete_self_enabled,false)
 // Simulate a previously enabled user whose native profile has already loaded
 // the old permission. Change only our fixture, then attempt deletion from the
 // existing session without refreshing its profile first.
 const legacyPolicy=await request(`/users/${encodeURIComponent(user.id)}`,'PATCH',{delete_self_enabled:true})
 assert.equal(legacyPolicy.status,200);assert.equal(legacyPolicy.body.delete_self_enabled,true)
 const legacyProfile=await nativeRequest(me);assert.equal(legacyProfile.status,200);assert.equal(legacyProfile.body.response?.delete_self_enabled,true)
 const protectedPolicy=await request(`/users/${encodeURIComponent(user.id)}`,'PATCH',{delete_self_enabled:false})
 assert.equal(protectedPolicy.status,200);assert.equal(protectedPolicy.body.delete_self_enabled,false)
 const selfDelete=await nativeRequest(me,'DELETE')
 assert.equal(selfDelete.status,403)
 assert.ok(selfDelete.body.errors?.some(error=>error.code==='user_delete_self_not_enabled'),'Deletion must be denied by provider policy, not an authentication error')
 assert.equal((await request(`/users/${encodeURIComponent(user.id)}`)).status,200)
 evidence.directSelfDeletionRejected=true;evidence.existingSessionPolicyEnforced=true;save()
 const profile=await nativeRequest(me,'PATCH',{first_name:'Cyntch profile test'})
 assert.equal(profile.status,200);assert.equal(profile.body.response?.first_name,'Cyntch profile test')
 assert.equal(profile.body.response.delete_self_enabled,false)
 evidence.profileUpdateAllowed=true;save()
 const f=await fixture(t,{owner:user.id}),intent=await f.intent();await f.accept(intent,{issuer:domain.frontend_api_url})
 const job={id:intent.operationId,accountId:user.id,leaseId:randomUUID(),work:{}}
 await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[job.id,job.leaseId])
 await f.lib.deleteAccountData(f.db,job)
 // This integration check exercises identity cleanup only. Billing provider
 // phases have separate tests and are not invoked against this fixture.
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{phases}','{"data":true,"stripe":true,"native":true,"identity":false}')`)
 const lib=f.load(['lib/account-deletion-identity.ts','lib/account-deletion-processing.ts'])
 let deleted=0,lost=false
 const provider={secretKey,fetcher:async(url,options)=>{
  assert.equal(new URL(url).origin,'https://api.clerk.com')
  if(options.method==='DELETE'){assert.equal(new URL(url).pathname,`/v1/users/${user.id}`);deleted++}
  const response=await fetch(url,options)
  if(options.method==='DELETE'&&response.status===200&&!lost){
   const acknowledgement=await response.json();assert.equal(acknowledgement.object,'user');assert.equal(acknowledgement.id,user.id);assert.equal(acknowledgement.deleted,true)
   lost=true;throw Error('Injected lost response')
  }
  return response
 }}
 await assert.rejects(lib.deleteAccountIdentity(f.db,job,provider),{code:'identity_cleanup_failed'})
 assert.equal(lost,true);assert.equal(deleted,1)
 assert.equal((await request(`/users/${user.id}`)).status,404)
 await lib.deleteAccountIdentity(f.db,job,provider);assert.equal(deleted,1)
 const work=(await f.db.query('select work from account_deletion_requests')).rows[0].work
 assert.equal(work.identity.instanceId,instance.body.id);assert.equal(work.identity.completed,true)
 await f.db.query('update account_deletion_requests set lease_id=null,lease_until=null')
 const result=await lib.processAccountDeletions(f.db,{data:async()=>assert.fail('already complete'),stripe:async()=>assert.fail('already complete'),native:async()=>assert.fail('already complete'),identity:job=>lib.deleteAccountIdentity(f.db,job,provider)},1)
 assert.equal(result.completed,1)
 const row=(await f.db.query('select * from account_deletion_requests')).rows[0]
 assert.equal(row.account_id,null);assert.deepEqual(row.work,{})
 evidence.lostDeleteResponseRecovered=true;evidence.verified=true;save()
})
