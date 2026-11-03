/* eslint-disable @typescript-eslint/no-require-imports -- Isolated PostgreSQL and actual HTTP/native protocol boundaries. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),options={skip:!connectionString}
async function setup(t){
 const f=await fixture(t),intent=await f.intent(),previous=process.env.ACCOUNT_DELETION_SUBMISSION_ENABLED
 process.env.ACCOUNT_DELETION_SUBMISSION_ENABLED='true';t.after(()=>{if(previous===undefined)delete process.env.ACCOUNT_DELETION_SUBMISSION_ENABLED;else process.env.ACCOUNT_DELETION_SUBMISSION_ENABLED=previous})
 const identity={userId:f.owner,sessionId:f.scope.sessionId,sessionClaims:{iss:'https://fixture.clerk.accounts.dev'},recent:true}
 let calls=0,lookup=async()=>({data:[{id:f.successor,banned:false,locked:false}],totalCount:1})
 const mocks={'@clerk/nextjs/server':{auth:async()=>({...identity,has:value=>{assert.deepEqual(value,{reverification:'strict'});return identity.recent}}),
  reverificationErrorResponse:require('@clerk/shared/authorization-errors').reverificationErrorResponse,
  clerkClient:async()=>({users:{getUserList:async args=>{calls++;assert.deepEqual(args,{userId:[f.successor],limit:1});return lookup()}}})}}
 const files=['app/api/mobile/account-deletion/route.ts','lib/account-deletion-status.ts','mobile/src/services/account-deletion-submission.ts']
 const lib=f.load(files,mocks),endpoint='https://www.cyntch.test/api/mobile/account-deletion'
 const headers={Authorization:'Bearer synthetic-token','Content-Type':'application/json','X-Task-Save-User':f.owner,'X-Cyntch-Session':f.scope.sessionId,
  'X-Cyntch-Device':f.scope.deviceId,'X-Cyntch-Installation':f.secret,'X-Cyntch-Deletion-Request':intent.operationId,'X-Cyntch-Deletion-Key':f.recoverySecret}
 const request=(changes={},body=intent,query='')=>new Request(endpoint+query,{method:'POST',headers:{...headers,...changes},body:typeof body==='string'?body:JSON.stringify(body)})
 return {...f,intent,identity,lib,files,mocks,endpoint,headers,request,calls:()=>calls,setLookup:fn=>{lookup=fn}}
}

test('submission gate, verified auth and strict reverification precede any acceptance or identity lookup',options,async t=>{
 const f=await setup(t)
 delete process.env.ACCOUNT_DELETION_SUBMISSION_ENABLED
 let response=await f.lib.POST(f.request({}, {...f.intent,ACCOUNT_DELETION_SUBMISSION_ENABLED:true,recentlyVerified:true}))
 assert.equal(response.status,503);assert.equal((await response.json()).code,'account_deletion_unavailable')
 process.env.ACCOUNT_DELETION_SUBMISSION_ENABLED='true'
 f.identity.userId=null;assert.equal((await f.lib.POST(f.request())).status,401);f.identity.userId=f.owner
 for(const patch of [{'X-Task-Save-User':f.other},{'X-Cyntch-Session':'sess_other'},{Authorization:''}])assert.equal((await f.lib.POST(f.request(patch))).status,403)
 assert.equal((await f.lib.POST(f.request({},f.intent,'?key=forbidden'))).status,400)
 f.identity.recent=false;response=await f.lib.POST(f.request({}, {...f.intent,recentlyVerified:true}))
 assert.equal(response.status,403);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer')
 assert.deepEqual(await response.json(),await require('@clerk/shared/authorization-errors').reverificationErrorResponse('strict').json())
 assert.equal(f.calls(),0);assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
 assert.equal((await f.db.query('select 1 from households')).rowCount,3)
})

test('native submission reaches real acceptance, returns minimal recovery status and replays without another provider lookup',options,async t=>{
 const f=await setup(t),api=new f.lib.AccountDeletionSubmissionApi('https://www.cyntch.test',async(url,init)=>{
  const reply=await f.lib.POST(new Request(url,init));return {status:reply.status,url,redirected:false,headers:reply.headers,json:()=>reply.json()}
 })
 const saved={...f.scope,origin:api.origin,intent:f.intent,recovery:{requestId:f.intent.operationId,secret:f.recoverySecret}}
 const credentials={...f.scope,token:'synthetic-token',installationSecret:f.secret}
 const receipt=await api.submit(saved,credentials)
 assert.deepEqual(Object.keys(receipt).sort(),['accountId','deviceId','sessionId','status'])
 assert.equal(receipt.status.state,'pending');assert.equal(receipt.status.availableUntil,null)
 assert.deepEqual(receipt.status,await f.lib.readAccountDeletionStatus(f.db,saved.recovery))
 assert.equal((await f.db.query('select leader_id from households where id=$1',[f.transfer])).rows[0].leader_id,f.successor)
 assert.equal((await f.db.query('select 1 from households where id=$1',[f.deleting])).rowCount,0)
 f.setLookup(async()=>{throw new Error('Provider now unavailable')})
 assert.deepEqual(await api.submit(saved,{...credentials,token:'fresh-synthetic-token'}),receipt);assert.equal(f.calls(),1)
 assert.equal((await f.lib.POST(f.request({'X-Cyntch-Deletion-Key':'b'.repeat(64)}))).status,409)
 assert.equal((await f.lib.POST(f.request({}, {...f.intent,ownership:f.intent.ownership.map(row=>({householdId:row.householdId,action:'delete'}))}))).status,409)
 assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,1)
})

test('only available matching parent identities allow transfer; provider errors are sanitized',options,async t=>{
 const f=await setup(t)
 const probe={...f.intent,ownership:f.intent.ownership.map(row=>row.action==='transfer'?{...row,successorId:f.other}:row)}
 assert.equal((await f.lib.POST(f.request({},probe))).status,409);assert.equal(f.calls(),0)
 for(const data of [[],[{id:f.other,banned:false,locked:false}],[{id:f.successor,banned:true,locked:false}],[{id:f.successor,banned:false,locked:true}],[{id:f.successor,banned:false}]]){
  f.setLookup(async()=>({data}));const response=await f.lib.POST(f.request());assert.equal(response.status,409)
  assert.equal((await response.json()).code,'account_deletion_review_changed')
 }
 f.setLookup(async()=>{throw new Error('secret-from-provider')})
 const response=await f.lib.POST(f.request());assert.equal(response.status,503);assert.ok(!(await response.text()).includes('secret-from-provider'))
 assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
 assert.equal((await f.db.query('select leader_id from households where id=$1',[f.transfer])).rows[0].leader_id,f.owner)
})

test('submission rejects invalid JSON, oversized uploads, incomplete consent and mismatched recovery before provider work',options,async t=>{
 const f=await setup(t)
 for(const [headers,body,status]of[[{},'{',400],[{'Content-Type':'text/plain'},f.intent,415],[{},' '.repeat(65537),413],
  [{}, {...f.intent,confirmAccountDeletion:false},400],[{}, {...f.intent,acknowledgeSubscriptions:false},400],[{'X-Cyntch-Deletion-Request':randomUUID()},f.intent,400]]){
  assert.equal((await f.lib.POST(f.request(headers,body))).status,status)
 }
 assert.equal(f.calls(),0);assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
})

test('HTTP acceptance respects installation, revoked sessions, kiosk lock and changed review',options,async t=>{
 const f=await setup(t)
 assert.equal((await f.lib.POST(f.request({'X-Cyntch-Installation':'b'.repeat(64)}))).status,403)
 await f.db.query('insert into native_notification_revocations(device_id,account_id,session_id) values($1,$2,$3)',[f.scope.deviceId,f.owner,f.scope.sessionId])
 assert.equal((await f.lib.POST(f.request())).status,403)
 await f.db.query('delete from native_notification_revocations')
 await f.db.query("insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array[$6],array[$6],$7,$7)",[randomUUID(),f.owner,f.scope.sessionId,f.scope.deviceId,f.deleting,f.child,'a'.repeat(64)])
 assert.equal((await f.lib.POST(f.request())).status,423)
 await f.db.query('delete from native_kiosk_sessions')
 await f.db.query("update households set name='Changed household' where id=$1",[f.transfer])
 const response=await f.lib.POST(f.request());assert.equal(response.status,409);assert.equal((await response.json()).code,'account_deletion_review_changed')
 assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
})

test('submission quota charges failed attempts and permits no unbounded provider reads',options,async t=>{
 const f=await setup(t)
 const responses=await Promise.all(Array.from({length:30},()=>f.lib.POST(f.request({},'{'))))
 assert.ok(responses.every(response=>[400,429].includes(response.status)))
 assert.ok(responses.some(response=>response.status===429&&response.headers.get('retry-after')==='60'))
 const {accountHash}=f.load(['lib/account-access.ts'])
 const counts=(await f.db.query('select requests from application_rate_limits where bucket_key=$1',['deletion-submit:'+accountHash(f.owner)])).rows
 assert.ok(counts.length>=1&&counts.length<=2);assert.ok(counts.every(row=>row.requests<=10))
 assert.equal(f.calls(),0);assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
})

test('lost commit acknowledgement retains accepted work and can recover with the original key',options,async t=>{
 const f=await setup(t);let injected=false
 const db=new Proxy(f.db,{get(target,property){
  if(property==='connect')return async()=>{
   const client=await target.connect();let accepting=false;return new Proxy(client,{get(connection,key){
    if(key==='query')return async(...args)=>{if(args[0]==='begin')accepting=true;const result=await connection.query(...args);if(args[0]==='commit'&&accepting&&!injected){injected=true;throw new Error('lost acknowledgement')}return result}
    const value=Reflect.get(connection,key);return typeof value==='function'?value.bind(connection):value
   }})
  }
  const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value
 }})
 const lib=f.load(f.files,{...f.mocks,'@/lib/db':{db,kioskGateDb:db}})
 t.mock.method(console,'error',()=>{})
 const response=await lib.POST(f.request());assert.equal(response.status,503);assert.ok((await response.json()).error.includes('check its status'))
 assert.equal(injected,true);assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,1)
 const status=await f.lib.readAccountDeletionStatus(f.db,{requestId:f.intent.operationId,secret:f.recoverySecret});assert.equal(status.state,'pending')
 const retry=await lib.POST(f.request());assert.equal(retry.status,202);assert.deepEqual((await retry.json()).status,status)
 assert.equal(f.calls(),1)
})

test('completed replay matches recovery after local data erasure, including receipt expiry across database timezones and DST',options,async t=>{
 const f=await setup(t),accepted=await f.lib.POST(f.request());assert.equal(accepted.status,202)
 const cleanup=f.load(['lib/account-deletion-processing.ts','lib/account-deletion-data.ts'])
 const result=await cleanup.processAccountDeletions(f.db,{data:job=>cleanup.deleteAccountData(f.db,job),stripe:async()=>{},native:async()=>{},identity:async()=>{}},1)
 assert.equal(result.completed,1)
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,0)
 assert.equal((await f.db.query('select 1 from native_notification_installations where device_id=$1',[f.scope.deviceId])).rowCount,0)
 // Synthetic future dates keep the receipt unexpired whenever this test runs.
 // Sep-Dec crosses Sydney's annual DST change, independent of today's season.
 const completedMs=Date.UTC(new Date().getUTCFullYear()+1,8,15)
 await f.db.query('update account_deletion_requests set created_at=$1,completed_at=$2',[new Date(completedMs-86400000),new Date(completedMs)])
 const replay=await f.lib.POST(f.request());assert.equal(replay.status,200);const receipt=(await replay.json()).status
 assert.equal(receipt.availableUntil,new Date(completedMs+90*86400000).toISOString())
 const client=await f.db.connect()
 try{
  await client.query('begin');await client.query("set local timezone='Australia/Sydney'")
  assert.deepEqual(await f.lib.readAccountDeletionStatus(client,{requestId:f.intent.operationId,secret:f.recoverySecret}),receipt)
 }finally{await client.query('rollback');client.release()}
 assert.equal(f.calls(),1)
 assert.equal((await f.db.query('select 1 from native_notification_installations where device_id=$1',[f.scope.deviceId])).rowCount,0)
})
