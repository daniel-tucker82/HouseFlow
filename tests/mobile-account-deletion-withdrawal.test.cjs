/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL acceptance/withdrawal races and authorization. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),options={skip:!connectionString}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
async function setup(t){
 const f=await fixture(t),lib=f.load(['lib/account-deletion-withdrawal.ts','lib/account-deletion-status.ts']),intent=await f.intent()
 const recovery={requestId:intent.operationId,secret:f.recoverySecret}
 const withdraw=(opts={})=>lib.withdrawAccountDeletion(f.db,opts.scope??f.scope,opts.installation??f.secret,opts.recovery??recovery,opts.verified??true,opts.issuer??'https://fixture.clerk.accounts.dev')
 return {...f,lib,intent,recovery,withdraw}
}

test('withdrawal leaves the account intact and permanently fences that attempt while permitting a new review',options,async t=>{
 const f=await setup(t),receipt=await f.withdraw()
 assert.deepEqual(receipt,{...f.scope,requestId:f.intent.operationId,outcome:'withdrawn',withdrawnAt:receipt.withdrawnAt})
 assert.ok(Number.isFinite(Date.parse(receipt.withdrawnAt)))
 assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
 assert.equal((await f.db.query('select 1 from households where leader_id=$1',[f.owner])).rowCount,2)
 assert.equal((await f.db.query('select 1 from native_notification_devices where user_id=$1',[f.owner])).rowCount,1)
 const saved=(await f.db.query('select * from account_deletion_withdrawals')).rows[0]
 assert.deepEqual(Object.keys(saved).sort(),['id','account_hash','recovery_key_hash','created_at'].sort())
 assert.equal(JSON.stringify(saved).includes(f.owner),false);assert.equal(JSON.stringify(saved).includes(f.recoverySecret),false)
 assert.equal(saved.recovery_key_hash,f.lib.accountDeletionRecoveryHash(f.recoverySecret))
 assert.deepEqual(await f.withdraw(),receipt)
 await assert.rejects(f.accept(f.intent,{verify:async()=>assert.fail('A withdrawn attempt must not call providers')}),{status:409,code:'account_deletion_withdrawn'})
 await assert.rejects(f.accept(f.intent,{recoverySecret:'b'.repeat(64)}),{status:409,code:'account_deletion_withdrawn'})
 const next=await f.read();assert.equal(next.accountId,f.owner)
 assert.equal((await f.accept({...f.intent,operationId:randomUUID(),revision:next.revision})).state,'pending')
 assert.deepEqual(await f.withdraw(),receipt,'Replaying the old receipt must not affect the new deletion')
})

test('an accepted deletion cannot be withdrawn before or after data cleanup',options,async t=>{
 const f=await setup(t);await f.accept(f.intent)
 const before=(await f.db.query('select * from account_deletion_requests')).rows[0]
 assert.deepEqual(await f.withdraw(),{...f.scope,requestId:f.intent.operationId,outcome:'accepted',withdrawnAt:null})
 assert.deepEqual((await f.db.query('select * from account_deletion_requests')).rows[0],before)
 assert.equal((await f.db.query('select 1 from account_deletion_withdrawals')).rowCount,0)
 await assert.rejects(f.withdraw({recovery:{...f.recovery,secret:'0'.repeat(64)}}),{status:409})
 const processing=f.load(['lib/account-deletion-processing.ts','lib/account-deletion-data.ts'])
 assert.equal((await processing.processAccountDeletions(f.db,{data:job=>processing.deleteAccountData(f.db,job),stripe:async()=>{},native:async()=>{},identity:async()=>{}},1)).completed,1)
 assert.equal((await f.withdraw()).outcome,'accepted')
 assert.equal((await f.db.query('select 1 from native_notification_installations where device_id=$1',[f.scope.deviceId])).rowCount,0)
 assert.equal((await f.lib.readAccountDeletionStatus(f.db,f.recovery)).state,'completed')
})

test('withdrawal wins over an earlier submission still verifying successors and blocks its delayed acceptance',options,async t=>{
 const f=await setup(t),entered=deferred(),release=deferred()
 const submitting=f.accept(f.intent,{verify:async()=>{entered.resolve();await release.promise}})
 const rejection=assert.rejects(submitting,{status:409,code:'account_deletion_withdrawn'})
 await entered.promise
 try{assert.equal((await f.withdraw()).outcome,'withdrawn')}finally{release.resolve();await rejection}
 assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
 assert.equal((await f.db.query('select 1 from households where leader_id=$1',[f.owner])).rowCount,2)
})

test('withdrawal retries when acceptance owns the account lock and never reverses a committed acceptance',options,async t=>{
 const f=await setup(t),entered=deferred(),release=deferred(),requests=f.load(['lib/account-deletion-requests.ts'])
 const delayed={query:f.db.query.bind(f.db),connect:async()=>{
  const client=await f.db.connect();return {release:()=>client.release(),query:async(...args)=>{
   if(typeof args[0]==='string'&&args[0].includes('insert into account_deletion_requests')){entered.resolve();await release.promise}
   return client.query(...args)
  }}
 }}
 const submitting=requests.acceptAccountDeletion(delayed,f.scope,f.secret,f.intent,true,async()=>{},'https://fixture.clerk.accounts.dev',f.recoverySecret)
 await entered.promise
 try{await assert.rejects(f.withdraw(),{status:429,code:'account_deletion_busy'})}finally{release.resolve();await submitting}
 assert.equal((await f.withdraw()).outcome,'accepted');assert.equal((await f.db.query('select 1 from account_deletion_withdrawals')).rowCount,0)
})

test('database fences also reject an older writer that does not check withdrawal in application code',options,async t=>{
 const f=await setup(t);await f.withdraw()
 await assert.rejects(f.db.query("insert into account_deletion_requests(id,account_hash,account_id,request_hash,work) values($1,$2,$3,$4,'{}')",[f.intent.operationId,'a'.repeat(64),f.owner,'b'.repeat(64)]),{code:'P7603'})
 const next={...f.intent,operationId:randomUUID()};await f.accept(next)
 await assert.rejects(f.db.query('insert into account_deletion_withdrawals(id,account_hash,recovery_key_hash) values($1,$2,$3)',[next.operationId,'a'.repeat(64),'b'.repeat(64)]),{code:'P7603'})
 const client=await f.db.connect(),id=randomUUID()
 try{
  await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['account-deletion-operation:'+id])
  await assert.rejects(f.db.query('insert into account_deletion_withdrawals(id,account_hash,recovery_key_hash) values($1,$2,$3)',[id,'a'.repeat(64),'b'.repeat(64)]),{code:'P7602'})
 }finally{await client.query('rollback');client.release()}
})

test('withdrawal requires fresh authentication, matching installation and an unrestricted current session',options,async t=>{
 const f=await setup(t)
 await assert.rejects(f.withdraw({verified:false}),{status:403,code:'account_reverification_required'})
 await assert.rejects(f.withdraw({issuer:'http://unverified.test'}),{status:401})
 await assert.rejects(f.withdraw({recovery:{...f.recovery,requestId:'invalid'}}),{status:400})
 await assert.rejects(f.withdraw({installation:'b'.repeat(64)}),{status:403})
 await f.db.query('insert into native_notification_revocations(device_id,account_id,session_id) values($1,$2,$3)',[f.scope.deviceId,f.owner,f.scope.sessionId])
 await assert.rejects(f.withdraw(),{status:403,code:'account_session_ended'})
 const scope={...f.scope,sessionId:'sess_reverified'}
 await f.db.query("insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array[$6],array[$6],$7,$7)",[randomUUID(),f.owner,scope.sessionId,scope.deviceId,f.deleting,f.child,'a'.repeat(64)])
 await assert.rejects(f.withdraw({scope}),{status:423})
 assert.equal((await f.db.query('select 1 from account_deletion_withdrawals')).rowCount,0)
 await f.db.query('delete from native_kiosk_sessions')
 const receipt=await f.withdraw({scope});assert.equal(receipt.outcome,'withdrawn');assert.equal(receipt.sessionId,scope.sessionId)
 await assert.rejects(f.withdraw({scope:{accountId:f.other,sessionId:'sess_other',deviceId:f.otherDevice}}),{status:409})
 await assert.rejects(f.withdraw({scope,recovery:{...f.recovery,secret:'b'.repeat(64)}}),{status:409})
})

test('a failure committing withdrawal leaves no fence and retry can safely establish the outcome',options,async t=>{
 const f=await setup(t)
 await f.db.query("create function fail_withdrawal() returns trigger language plpgsql as $$ begin raise exception 'Injected interruption'; end $$; create trigger fail_withdrawal before insert on account_deletion_withdrawals for each row execute function fail_withdrawal()")
 await assert.rejects(f.withdraw(),/Injected interruption/)
 assert.equal((await f.db.query('select 1 from account_deletion_withdrawals')).rowCount,0)
 await f.db.query('drop trigger fail_withdrawal on account_deletion_withdrawals')
 assert.equal((await f.withdraw()).outcome,'withdrawn')
})

test('authenticated withdrawal attempts have a bounded rate even when their decision transaction fails',options,async t=>{
 const f=await setup(t)
 const results=await Promise.allSettled(Array.from({length:30},()=>f.withdraw({installation:'b'.repeat(64)})))
 assert.ok(results.every(r=>r.status==='rejected'&&[403,429].includes(r.reason.status)))
 assert.ok(results.some(r=>r.reason.code==='account_deletion_limited'))
 const rows=(await f.db.query("select requests from application_rate_limits where bucket_key like 'deletion-withdrawal:%'")).rows
 assert.ok(rows.length>=1&&rows.length<=2);assert.ok(rows.every(r=>r.requests<=10))
 assert.equal((await f.db.query('select 1 from account_deletion_withdrawals')).rowCount,0)
})

test('withdrawal HTTP trusts verified auth only and preserves Clerk reverification responses',options,async t=>{
 const f=await setup(t),identity={userId:f.owner,sessionId:f.scope.sessionId,sessionClaims:{iss:'https://fixture.clerk.accounts.dev'},recent:false}
 const lib=f.load(['app/api/mobile/account-deletion/withdraw/route.ts'],{'@clerk/nextjs/server':{
  auth:async()=>({...identity,has:args=>{assert.deepEqual(args,{reverification:'strict'});return identity.recent}}),
  reverificationErrorResponse:require('@clerk/shared/authorization-errors').reverificationErrorResponse,
 }})
 const request=(headers={},query='')=>new Request('https://cyntch.test/api/mobile/account-deletion/withdraw'+query,{method:'POST',headers:{
  'X-Task-Save-User':f.owner,'X-Cyntch-Session':identity.sessionId,'X-Cyntch-Device':f.scope.deviceId,'X-Cyntch-Installation':f.secret,
  'X-Cyntch-Deletion-Request':f.intent.operationId,'X-Cyntch-Deletion-Key':f.recoverySecret,...headers,
 },body:JSON.stringify({recentlyVerified:true,accountId:f.other})})
 identity.userId=null;assert.equal((await lib.POST(request())).status,401);identity.userId=f.owner
 assert.equal((await lib.POST(request({'X-Task-Save-User':f.other}))).status,403)
 const reverification=await lib.POST(request());assert.equal(reverification.status,403);assert.equal(reverification.headers.get('cache-control'),'private, no-store')
 assert.deepEqual(await reverification.json(),await require('@clerk/shared/authorization-errors').reverificationErrorResponse('strict').json())
 assert.equal((await f.db.query('select 1 from account_deletion_withdrawals')).rowCount,0)
 identity.recent=true;assert.equal((await lib.POST(request({},'?recovery=forbidden'))).status,400)
 assert.equal((await lib.POST(request({'X-Cyntch-Session':'sess_wrong'}))).status,403)
 const response=await lib.POST(request());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store')
 assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal((await response.json()).outcome,'withdrawn')
})
