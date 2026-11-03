/* eslint-disable @typescript-eslint/no-require-imports -- PostgreSQL recovery tests with synthetic Clerk/Apple transports and ephemeral crypto keys. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes,generateKeyPairSync,verify}=require('node:crypto')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),options={skip:!connectionString}
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'})
const idToken=claims=>[Buffer.from(JSON.stringify({alg:'RS256'})).toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url'),'clerk-verified-fixture'].join('.')
const absent=()=>Response.json({errors:[{code:'resource_not_found'}]},{status:404})
async function setup(t){
 const f=await fixture(t),intent=await f.intent();await f.accept(intent)
 const job={id:intent.operationId,accountId:f.owner,leaseId:randomUUID(),work:{}}
 await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[job.id,job.leaseId])
 await f.lib.deleteAccountData(f.db,job)
 await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{phases}','{"data":true,"stripe":true,"native":true,"identity":false}')`)
 const external={id:'eac_apple_fixture',provider:'oauth_apple',provider_user_id:'apple_subject'},token='apple-access-secret-'+randomUUID(),clientId='com.cyntch.signin'
 const claims={iss:'https://appleid.apple.com',sub:external.provider_user_id,aud:clientId}
 const state={user:{object:'user',id:f.owner,external_accounts:[external]},tokens:[{object:'oauth_access_token',external_account_id:external.id,provider_user_id:external.provider_user_id,provider:'oauth_apple',token,id_token:idToken(claims)}],onClerk:null,onApple:null,appleCalls:0,tokenReads:0,deletes:0}
 const config={clients:[{clientId,teamId:'TEAM123456',keyId:'KEY1234567',privateKey}],tokenKeys:{current:'v1',keys:{v1:randomBytes(32).toString('base64')}}}
 const read=async()=>(await f.db.query('select * from account_deletion_requests where id=$1',[job.id])).rows[0]
 const provider={secretKey:'sk_test_fixture',apple:config,fetcher:async(input,init)=>{
  const url=new URL(input)
  assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.ok(init.signal instanceof AbortSignal)
  if(url.origin==='https://appleid.apple.com'){
   assert.equal(url.pathname,'/auth/revoke');assert.equal(init.method,'POST');assert.equal(init.headers.Authorization,undefined)
   assert.equal(init.headers['Content-Type'],'application/x-www-form-urlencoded')
   const body=new URLSearchParams(init.body);assert.equal(body.get('token'),token);assert.equal(body.get('token_type_hint'),'access_token');assert.equal(body.get('client_id'),clientId)
   const jwt=body.get('client_secret').split('.'),header=JSON.parse(Buffer.from(jwt[0],'base64url')),payload=JSON.parse(Buffer.from(jwt[1],'base64url'))
   assert.deepEqual(header,{alg:'ES256',kid:'KEY1234567'});assert.equal(payload.sub,clientId);assert.equal(payload.iss,'TEAM123456');assert.equal(payload.aud,'https://appleid.apple.com');assert.equal(payload.exp-payload.iat,300)
   assert.ok(verify('sha256',Buffer.from(jwt.slice(0,2).join('.')),{key:pair.publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(jwt[2],'base64url')))
   const row=await read();assert.ok(row.work.identity.appleRevocations[0].credential,'Encrypted recovery checkpoint is committed before sending revocation')
   assert.equal(JSON.stringify(row).includes(token),false);assert.equal(JSON.stringify(row).includes(privateKey),false)
   state.appleCalls++;return state.onApple?await state.onApple(init):new Response('',{status:200})
  }
  assert.equal(url.origin,'https://api.clerk.com');assert.equal(init.headers.Authorization,'Bearer sk_test_fixture')
  if(state.onClerk){const result=await state.onClerk(url,init);if(result)return result}
  if(url.pathname==='/v1/instance')return Response.json({object:'instance',id:'ins_fixture',environment_type:'development'})
  if(url.pathname==='/v1/domains')return Response.json({data:[{object:'domain',frontend_api_url:'https://fixture.clerk.accounts.dev'}],total_count:1})
  if(url.pathname.endsWith('/oauth_access_tokens/oauth_apple')){
   state.tokenReads++;assert.equal(url.searchParams.get('paginated'),'true');assert.equal(url.searchParams.get('limit'),'100')
   const offset=Number(url.searchParams.get('offset'));return Response.json({data:state.tokens.slice(offset,offset+100),total_count:state.tokens.length})
  }
  assert.equal(url.pathname,`/v1/users/${f.owner}`)
  if(!state.user)return absent()
  if(init.method==='DELETE'){state.deletes++;state.user=null;return Response.json({object:'user',id:f.owner,deleted:true})}
  return Response.json(state.user)
 }}
 const lib=f.load(['lib/account-deletion-identity.ts','lib/account-deletion-processing.ts'])
 return {...f,intent,job,state,provider,config,token,claims,external,read,lib,cleanup:()=>lib.deleteAccountIdentity(f.db,job,provider)}
}

test('Apple revocation commits encrypted recovery data first, verifies a signed client secret and scrubs credentials before Clerk deletion',options,async t=>{
 const f=await setup(t);await f.cleanup();const row=await f.read()
 assert.equal(f.state.appleCalls,1);assert.equal(f.state.deletes,1);assert.equal(f.state.tokenReads,1)
 assert.deepEqual(row.work.identity.appleRevocations,[{externalId:f.external.id,status:'revoked'}]);assert.equal(row.apple_revocation_required,false);assert.equal(row.work.identity.completed,true)
 assert.equal(JSON.stringify(row).includes(f.token),false);assert.equal(JSON.stringify(row).includes('ciphertext'),false)
})

test('a lost Apple revocation response resumes with the encrypted token even when Clerk can no longer supply it',options,async t=>{
 const f=await setup(t);f.state.onApple=async()=>{throw Error('Lost Apple response contains private token')}
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed',message:'identity_cleanup_failed'})
 let row=await f.read();assert.ok(row.work.identity.appleRevocations[0].credential);assert.equal(row.work.identity.appleRevocations[0].status,'pending');assert.equal(f.state.deletes,0)
 f.state.onApple=null;f.state.onClerk=async url=>{if(url.pathname.endsWith('/oauth_apple'))assert.fail('Do not re-fetch a token after revocation')}
 f.config.tokenKeys.current='v2';f.config.tokenKeys.keys.v2=randomBytes(32).toString('base64')
 await f.cleanup();assert.equal(f.state.appleCalls,2);assert.equal(f.state.tokenReads,1);assert.equal(f.state.deletes,1)
 row=await f.read();assert.equal(row.work.identity.completed,true);assert.equal(JSON.stringify(row).includes('ciphertext'),false)
})

test('Apple recovery survives removal of the Clerk user while a saved revocation remains pending',options,async t=>{
 const f=await setup(t);f.state.onApple=async()=>{throw Error('interrupted')};await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'})
 f.state.user=null;f.state.onApple=null;await f.cleanup()
 assert.equal(f.state.appleCalls,2);assert.equal(f.state.tokenReads,1);assert.equal((await f.read()).work.identity.completed,true)
})

test('encrypted Apple recovery rejects tampering, missing keys and ciphertext copied to another scope',options,async t=>{
 const f=await setup(t);f.state.onApple=async()=>{throw Error('interrupted')};await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'})
 const record=(await f.read()).work.identity.appleRevocations[0]
 for(const changed of [{...record,externalId:'eac_foreign'},{...record,clientId:'com.other.app'},{...record,credential:{...record.credential,keyId:'missing'}},{...record,credential:{...record.credential,tag:randomBytes(16).toString('base64url')}}]){
  await f.db.query(`update account_deletion_requests set work=jsonb_set(work,'{identity,appleRevocations}',$1::jsonb)`,[JSON.stringify([changed])])
  await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'})
 }
 assert.equal(f.state.appleCalls,1);assert.equal(f.state.deletes,0)
})

test('unavailable Apple credentials preserve manual revocation instructions after account cleanup',options,async t=>{
 const f=await setup(t);f.state.tokens=[];delete f.provider.apple
 await f.cleanup();let row=await f.read()
 assert.equal(row.apple_revocation_required,true);assert.deepEqual(row.work.identity.appleRevocations,[{externalId:f.external.id,status:'manual'}]);assert.equal(f.state.appleCalls,0);assert.equal(f.state.deletes,1)
 assert.equal((await f.accept(f.intent)).appleRevocationRequired,true)
 await f.db.query('update account_deletion_requests set lease_id=null,lease_until=null')
 const result=await f.lib.processAccountDeletions(f.db,{data:async()=>assert.fail('done'),stripe:async()=>assert.fail('done'),native:async()=>assert.fail('done'),identity:job=>f.lib.deleteAccountIdentity(f.db,job,f.provider)},1)
 assert.equal(result.completed,1);row=await f.read();assert.equal(row.account_id,null);assert.deepEqual(row.work,{});assert.equal(row.apple_revocation_required,true)
})

test('documented shared-credential token errors use manual revocation, while temporary provider failures keep deletion pending',options,async t=>{
 const f=await setup(t)
 for(const status of [401,403,429,500]){
  f.state.onClerk=async url=>url.pathname.endsWith('/oauth_apple')?Response.json({errors:[{code:'provider_unavailable'}]},{status}):null
  await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});assert.equal((await f.read()).apple_revocation_required,false);assert.equal(f.state.deletes,0)
 }
 f.state.onClerk=async url=>url.pathname.endsWith('/oauth_apple')?Response.json({errors:[{code:'oauth_shared_credentials_stored_token_not_retrievable'}]},{status:422}):null
 await f.cleanup();assert.equal((await f.read()).apple_revocation_required,true);assert.equal(f.state.deletes,1)
})

test('foreign Apple identities, unsupported clients and ambiguous tokens cannot trigger revocation or Clerk deletion',options,async t=>{
 const f=await setup(t),original=f.state.tokens[0]
 for(const changed of [{...original,provider:'oauth_google'},{...original,provider_user_id:'someone_else'},{...original,id_token:idToken({...f.claims,sub:'someone_else'})},{...original,id_token:idToken({...f.claims,aud:'com.foreign.client'})},{...original,id_token:idToken({...f.claims,iss:'https://attacker.test'})}]){
  f.state.tokens=[changed];await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'})
 }
 f.state.tokens=[original,original];await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'})
 assert.equal(f.state.appleCalls,0);assert.equal(f.state.deletes,0);assert.equal((await f.read()).apple_revocation_required,false)
})

test('Apple errors and nonempty success responses never acknowledge revocation',options,async t=>{
 const f=await setup(t)
 for(const [status,body]of [[400,'{"error":"invalid_client"}'],[503,'unavailable'],[200,'{"error":"invalid_token"}'],[204,'']]){
  f.state.onApple=async()=>new Response(status===204?null:body,{status})
  await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'})
  assert.equal((await f.read()).work.identity.appleRevocations[0].status,'pending');assert.equal(f.state.deletes,0)
 }
 f.state.onApple=null;await f.cleanup();assert.equal(f.state.tokenReads,1);assert.equal(f.state.deletes,1)
})

test('expired workers cannot acknowledge Apple revocation and a new lease safely retries the saved token',options,async t=>{
 const f=await setup(t);f.state.onApple=async()=>{await f.db.query("update account_deletion_requests set lease_until=now()-interval '1 second'");return new Response('',{status:200})}
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});assert.ok((await f.read()).work.identity.appleRevocations[0].credential);assert.equal(f.state.deletes,0)
 f.job.leaseId=randomUUID();await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[f.job.id,f.job.leaseId])
 f.state.onApple=null;await f.cleanup();assert.equal(f.state.appleCalls,2);assert.equal(f.state.tokenReads,1)
})

test('Apple checkpoint save failure prevents an external revocation request',options,async t=>{
 const f=await setup(t);f.state.onClerk=async url=>{if(url.pathname.endsWith('/oauth_apple'))await f.db.query("update account_deletion_requests set lease_until=now()-interval '1 second'")}
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});assert.equal(f.state.appleCalls,0);assert.equal(f.state.deletes,0)
 assert.equal((await f.read()).work.identity.appleRevocations[0].credential,undefined)
})

test('Apple requests abort within the processing budget and keep encrypted work for retry',options,async t=>{
 const f=await setup(t);let aborted=false
 f.state.onApple=async init=>new Promise((_resolve,reject)=>{const abort=()=>{aborted=true;reject(init.signal.reason)};if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true})})
 await assert.rejects(f.lib.deleteAccountIdentity(f.db,f.job,f.provider,15,()=>0),{code:'identity_cleanup_failed'})
 assert.equal(aborted,true);assert.ok((await f.read()).work.identity.appleRevocations[0].credential);assert.equal(f.state.deletes,0)
})

test('a newly linked Apple identity is detected again before Clerk deletion',options,async t=>{
 const f=await setup(t);f.state.onApple=async()=>{f.state.user.external_accounts.push({...f.external,id:'eac_new'});return new Response('',{status:200})}
 await assert.rejects(f.cleanup(),{code:'cleanup_pending',retryAfterSeconds:1});assert.equal(f.state.deletes,0)
 f.state.onApple=null;await f.cleanup();assert.equal(f.state.deletes,1);assert.equal((await f.read()).apple_revocation_required,true,'New identity with no token uses explicit manual instructions')
})

test('Apple token selection reads every Clerk page before deciding that a credential is missing',options,async t=>{
 const f=await setup(t),wanted=f.state.tokens[0]
 f.state.tokens=[...Array.from({length:100},(_,index)=>({...wanted,external_account_id:`eac_unrelated_${index}`})),wanted]
 await f.cleanup();assert.equal(f.state.tokenReads,2);assert.equal(f.state.appleCalls,1);assert.equal((await f.read()).apple_revocation_required,false)
})

test('Apple recovery ciphertext cannot be copied to a different deletion request even when the encryption key is shared',options,async t=>{
 const source=await setup(t);source.state.onApple=async()=>{throw Error('interrupted')};await assert.rejects(source.cleanup(),{code:'identity_cleanup_failed'})
 const target=await setup(t);target.provider.apple=source.config
 await target.db.query(`update account_deletion_requests set work=jsonb_set(work,'{identity,appleRevocations}',$1::jsonb)`,[JSON.stringify((await source.read()).work.identity.appleRevocations)])
 await assert.rejects(target.cleanup(),{code:'identity_cleanup_failed'});assert.equal(target.state.appleCalls,0);assert.equal(target.state.deletes,0)
})

test('missing Apple encryption configuration never sends a token or silently chooses manual revocation',options,async t=>{
 const f=await setup(t);f.config.tokenKeys.keys.v1=Buffer.alloc(16).toString('base64')
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'});assert.equal(f.state.appleCalls,0);assert.equal(f.state.deletes,0)
 const row=await f.read();assert.equal(row.apple_revocation_required,false);assert.equal(JSON.stringify(row).includes(f.token),false)
})

test('a pending Apple identity with no saved token falls back honestly if its Clerk user disappears',options,async t=>{
 const f=await setup(t);f.state.onClerk=async url=>url.pathname.endsWith('/oauth_apple')?Response.json({errors:[{code:'upstream_error'}]},{status:503}):null
 await assert.rejects(f.cleanup(),{code:'identity_cleanup_failed'})
 assert.equal((await f.read()).work.identity.appleRevocations[0].credential,undefined)
 f.state.user=null;f.state.onClerk=null;delete f.provider.apple
 await f.cleanup();const row=await f.read();assert.equal(row.work.identity.completed,true);assert.equal(row.apple_revocation_required,true);assert.equal(f.state.appleCalls,0)
})
