/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL deletion-status security and recovery checks. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),options={skip:!connectionString}
const files=['lib/account-deletion-status.ts','app/api/mobile/account-deletion/status/route.ts','shared/mobile/account-deletion.ts']
const recovery=(f,intent)=>({requestId:intent.operationId,secret:f.recoverySecret})
const request=(key,suffix='')=>new Request('https://cyntch.test/api/mobile/account-deletion/status'+suffix,{headers:{'X-Cyntch-Deletion-Request':key.requestId,'X-Cyntch-Deletion-Key':key.secret}})

test('the recovery hash commits with acceptance and lost acknowledgements keep the original capability',options,async t=>{
 const f=await fixture(t),lib=f.load(files),intent=await f.intent()
 for(const secret of ['',null,undefined,{},'b'.repeat(63),'B'.repeat(64)]){
  await assert.rejects(f.lib.acceptAccountDeletion(f.db,f.scope,f.secret,intent,true,async()=>assert.fail('Invalid key called a provider'),'https://fixture.clerk.accounts.dev',secret),{status:400})
 }
 assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
 assert.equal((await f.db.query('select 1 from households where leader_id=$1',[f.owner])).rowCount,2)
 const accepted=await f.accept(intent),key=recovery(f,intent),row=(await f.db.query('select * from account_deletion_requests')).rows[0]
 assert.equal(row.recovery_key_hash,lib.accountDeletionRecoveryHash(key.secret))
 assert.equal(JSON.stringify(row).includes(key.secret),false);assert.equal(JSON.stringify(accepted).includes(key.secret),false)
 assert.deepEqual(await f.accept(intent),accepted)
 await assert.rejects(f.accept(intent,{recoverySecret:randomBytes(32).toString('hex')}),{status:409})
 assert.equal((await lib.readAccountDeletionStatus(f.db,key)).state,'pending')
})

test('status works after erasing account and device data and retains the Apple manual-action outcome',options,async t=>{
 const f=await fixture(t),lib=f.load(files,{'@clerk/nextjs/server':{auth:async()=>assert.fail('Status must not authenticate a deleted session')}}),intent=await f.intent()
 await f.accept(intent)
 const key=recovery(f,intent),before=await lib.GET(request(key)),pending=await before.json()
 assert.equal(before.status,200);assert.equal(before.headers.get('retry-after'),'15')
 assert.deepEqual(Object.keys(pending).sort(),['requestId','state','acceptedAt','completedAt','appleRevocationRequired','availableUntil'].sort())
 assert.equal(pending.state,'pending');assert.equal(pending.completedAt,null);assert.equal(pending.availableUntil,null)
 const result=await f.lib.processAccountDeletions(f.db,{data:job=>f.lib.deleteAccountData(f.db,job),stripe:async()=>{},native:async()=>{},identity:async()=>{
  await f.db.query('update account_deletion_requests set apple_revocation_required=true where id=$1',[key.requestId])
 }},1)
 assert.equal(result.completed,1)
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,0)
 assert.equal((await f.db.query('select 1 from native_notification_installations where device_id=$1',[f.scope.deviceId])).rowCount,0)
 f.identity.userId=null;f.identity.sessionId=null
 const response=await lib.GET(request(key)),status=await response.json()
 assert.equal(response.status,200);assert.equal(status.state,'completed');assert.equal(status.appleRevocationRequired,true)
 assert.equal(status.acceptedAt,pending.acceptedAt);assert.ok(Date.parse(status.availableUntil)>Date.parse(status.completedAt))
 assert.deepEqual(lib.parseAccountDeletionStatus(status,key.requestId),status)
 const stored=(await f.db.query('select * from account_deletion_requests')).rows[0]
 assert.deepEqual(stored.work,{});assert.equal(stored.account_id,null);assert.equal(stored.recovery_key_hash,lib.accountDeletionRecoveryHash(key.secret))
 assert.equal(response.headers.get('retry-after'),null)
})

test('unknown, wrong, malformed and expired credentials share a private non-disclosing response',options,async t=>{
 const f=await fixture(t),lib=f.load(files),intent=await f.intent();await f.accept(intent)
 const key=recovery(f,intent),bad=[{...key,requestId:randomUUID()},{...key,secret:'0'.repeat(64)},{...key,requestId:'invalid'},{...key,secret:''}]
 let body
 for(const item of bad){const response=await lib.GET(request(item));assert.equal(response.status,404);const current=await response.json();body??=current;assert.deepEqual(current,body)}
 assert.equal((await f.db.query("select 1 from application_rate_limits where bucket_key like 'deletion-status:%'")).rowCount,0)
 await f.db.query("update account_deletion_requests set state='completed',account_id=null,work='{}',next_attempt_at=null,created_at=now()-interval '110 days',completed_at=now()-interval '91 days'")
 const expired=await lib.GET(request(key));assert.equal(expired.status,404);assert.deepEqual(await expired.json(),body)
 await assert.rejects(f.lib.assertAccountActive(f.db,f.owner),{status:410})
 assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,1,'Expiry must not remove the anti-resurrection tombstone')
})

test('pending recovery does not expire or expose provider failure details and cannot advance cleanup',options,async t=>{
 const f=await fixture(t),lib=f.load(files),intent=await f.intent();await f.accept(intent)
 await f.db.query("update account_deletion_requests set created_at=now()-interval '110 days',last_error_code='private-provider-error',attempts=9")
 const before=(await f.db.query('select * from account_deletion_requests')).rows[0]
 const result=await lib.readAccountDeletionStatus(f.db,recovery(f,intent))
 assert.equal(result.state,'pending');assert.equal(JSON.stringify(result).includes('private-provider-error'),false)
 for(const hidden of ['cus_transfer',f.owner,f.deleting,f.native,f.scope.deviceId,f.recoverySecret])assert.equal(JSON.stringify(result).includes(hidden),false)
 assert.deepEqual((await f.db.query('select * from account_deletion_requests')).rows[0],before)
})

test('concurrent status reads obey the minute limit without invalid credentials exhausting it',options,async t=>{
 const f=await fixture(t),lib=f.load(files),intent=await f.intent();await f.accept(intent)
 const key=recovery(f,intent)
 await Promise.all(Array.from({length:35},()=>assert.rejects(lib.readAccountDeletionStatus(f.db,{...key,secret:'0'.repeat(64)}),{status:404})))
 const results=await Promise.allSettled(Array.from({length:100},()=>lib.readAccountDeletionStatus(f.db,key)))
 const passed=results.filter(r=>r.status==='fulfilled').length
 assert.ok(passed>=30&&passed<=60,`Expected one or two minute windows; received ${passed}`)
 for(const r of results)if(r.status==='rejected')assert.equal(r.reason.status,429)
 const counters=(await f.db.query("select requests from application_rate_limits where bucket_key like 'deletion-status:%'")).rows
 assert.ok(counters.length>=1&&counters.length<=2);assert.ok(counters.every(row=>row.requests>=1&&row.requests<=30))
 assert.equal(counters.reduce((sum,row)=>sum+row.requests,0),passed)
 // This transaction fixes now() for the check even if the clock crosses a minute.
 const client=await f.db.connect()
 try{
  await client.query('begin')
  await client.query("insert into application_rate_limits values($1,date_trunc('minute',now()),30) on conflict(bucket_key,window_start) do update set requests=30",['deletion-status:'+key.requestId])
  const limited=f.load(files,{'@/lib/db':{db:client}}),response=await limited.GET(request(key))
  assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'60')
  assert.equal((await response.json()).code,'account_deletion_status_limited')
 }finally{await client.query('rollback');client.release()}
})

test('status HTTP responses are uncached and query credentials are rejected without lookup',options,async t=>{
 const f=await fixture(t),lib=f.load(files),intent=await f.intent();await f.accept(intent)
 const key=recovery(f,intent)
 const noLookup=f.load(files,{'@/lib/db':{db:{query:()=>assert.fail('Query credentials must not reach storage')}}})
 const responses=[await lib.GET(request(key)),await lib.GET(request({...key,secret:''})),await noLookup.GET(request(key,'?key='+key.secret))]
 assert.deepEqual(responses.map(response=>response.status),[200,404,404])
 for(const response of responses){
  assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('pragma'),'no-cache')
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('vary'),'X-Cyntch-Deletion-Request, X-Cyntch-Deletion-Key')
  assert.equal((await response.text()).includes(key.secret),false)
 }
})

test('storage failures return a retry response and do not log recovery keys or provider data',options,async t=>{
 const f=await fixture(t),lib=f.load(files,{'@/lib/db':{db:{query:async()=>{throw new Error('secret-provider-value')}}}})
 const key={requestId:randomUUID(),secret:randomBytes(32).toString('hex')},messages=[],original=console.error
 try{
  console.error=(...args)=>messages.push(args)
  const response=await lib.GET(request(key));assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'private, no-store')
  assert.deepEqual(await response.json(),{error:'Unable to check deletion right now. Please retry.',code:'account_deletion_status_retry'})
 }finally{console.error=original}
 assert.deepEqual(messages,[['[account-deletion] Status lookup needs retry']])
})
