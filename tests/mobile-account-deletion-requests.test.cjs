/* eslint-disable @typescript-eslint/no-require-imports -- Real database acceptance, rollback and interruption boundaries. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),options={skip:!connectionString}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
test('deletion acceptance atomically preserves chosen households and queues provider cleanup',options,async t=>{
 const f=await fixture(t),intent=await f.intent(),receipt=await f.accept(intent)
 assert.equal(receipt.state,'pending');assert.equal(receipt.requestId,intent.operationId)
 const saved=(await f.db.query('select * from account_deletion_requests')).rows[0]
 assert.equal(saved.account_hash,f.lib.accountHash(f.owner));assert.equal(saved.account_id,f.owner)
 assert.deepEqual(saved.work.phases,{data:false,stripe:false,native:false,identity:false})
 assert.deepEqual(saved.work.orphanProfileIds,[f.child]);assert.equal(saved.work.retiredNativeAccounts[0].id,f.native)
 assert.equal(saved.work.stripe.length,2);assert.equal(JSON.stringify(receipt).includes('cus_'),false)
 assert.equal((await f.db.query('select leader_id from households where id=$1',[f.transfer])).rows[0].leader_id,f.successor)
 assert.equal((await f.db.query('select role from household_members where household_id=$1 and user_id=$2',[f.transfer,f.successor])).rows[0].role,'manager')
 assert.equal((await f.db.query('select 1 from households where id=$1',[f.deleting])).rowCount,0)
 assert.equal((await f.db.query('select 1 from household_members where user_id=$1',[f.owner])).rowCount,0)
 const departures=(await f.db.query("select household_id,subject->>'departureReason' as reason from native_notification_events where kind='member_left' and subject->>'memberId'=$1",[f.owner])).rows
 assert.deepEqual(departures.map(row=>row.household_id).sort(),[f.transfer,f.shared].sort())
 assert(departures.every(row=>row.reason==='left'),'self-requested account deletion is recorded as leaving surviving households')
 assert.equal((await f.db.query('select 1 from household_invites where created_by=$1',[f.owner])).rowCount,0)
 for(const table of ['native_notification_devices','push_subscriptions','mobile_push_tokens']){
  assert.equal((await f.db.query(`select 1 from ${table} where user_id=$1`,[f.owner])).rowCount,0)
  assert.equal((await f.db.query(`select 1 from ${table} where user_id=$1`,[f.other])).rowCount,1)
 }
 assert.equal((await f.db.query('select household_id from native_billing_accounts where id=$1',[f.native])).rows[0].household_id,null)
 assert.equal((await f.db.query('select 1 from native_subscriptions where account_id=$1',[f.native])).rowCount,1,'Retired purchases cannot be rebound to another household')
 assert.equal((await f.db.query('select 1 from routines where household_id=$1',[f.transfer])).rowCount,1)
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.sharedChild])).rowCount,1)
})
test('lost acknowledgements replay the accepted outcome without repeating provider checks or effects',options,async t=>{
 const f=await fixture(t),intent=await f.intent(),first=await f.accept(intent)
 const again=await f.accept(intent,{verify:async()=>assert.fail('An accepted operation must not depend on another provider lookup')})
 assert.deepEqual(again,first);assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,1)
 await assert.rejects(f.accept({...intent,operationId:randomUUID()}),{status:409})
 await assert.rejects(f.accept({...intent,ownership:intent.ownership.map(choice=>({...choice,action:'delete'}))}),{status:409})
})
test('unverified, changed, revoked and kiosk sessions cannot accept deletion',options,async t=>{
 const f=await fixture(t),intent=await f.intent()
 await assert.rejects(f.accept(intent,{verified:false}),{status:403,code:'account_reverification_required'})
 await assert.rejects(f.accept(intent,{secret:'b'.repeat(64)}),{status:403})
 await assert.rejects(f.accept({...intent,revision:'0'.repeat(64)}),{status:409})
 await f.db.query('insert into native_notification_revocations(device_id,account_id,session_id) values($1,$2,$3)',[f.scope.deviceId,f.owner,f.scope.sessionId])
 await assert.rejects(f.accept(intent),{status:403});await f.db.query('delete from native_notification_revocations')
 await f.db.query("insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array[$6],array[$6],$7,$7)",[randomUUID(),f.owner,f.scope.sessionId,f.scope.deviceId,f.deleting,f.child,'a'.repeat(64)])
 await assert.rejects(f.accept(intent),{status:423})
 assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
 assert.equal((await f.db.query('select 1 from households where leader_id=$1',[f.owner])).rowCount,2)
})
test('provider failure or a role change during verification leaves deletion unaccepted',options,async t=>{
 const f=await fixture(t),intent=await f.intent()
 await assert.rejects(f.accept(intent,{verify:async()=>{throw new Error('Provider unavailable')}}),/Provider unavailable/)
 await assert.rejects(f.accept(intent,{verify:async()=>{await f.db.query("update household_members set role='member' where household_id=$1 and user_id=$2",[f.transfer,f.successor])}}),{status:409})
 assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
 assert.equal((await f.db.query('select 1 from households where leader_id=$1',[f.owner])).rowCount,2)
})
test('a failure after transfer rolls back the request, all household changes and push removal',options,async t=>{
 const f=await fixture(t),intent=await f.intent()
 await f.db.query("create function fail_deletion() returns trigger language plpgsql as $$ begin if old.user_id like 'user_delete_%' then raise exception 'Injected interruption'; end if; return old; end $$; create trigger fail_deletion before delete on household_members for each row execute function fail_deletion()")
 await assert.rejects(f.accept(intent),/Injected interruption/)
 assert.equal((await f.db.query('select 1 from account_deletion_requests')).rowCount,0)
 assert.equal((await f.db.query('select 1 from households where leader_id=$1',[f.owner])).rowCount,2)
 assert.equal((await f.db.query('select role from household_members where household_id=$1 and user_id=$2',[f.transfer,f.successor])).rows[0].role,'supervisor')
 assert.equal((await f.db.query('select 1 from native_notification_devices where user_id=$1',[f.owner])).rowCount,1)
 await f.db.query('drop trigger fail_deletion on household_members');await f.accept(intent)
})
test('an admitted account request finishes before deletion; later sessions cannot read or write',options,async t=>{
 const f=await fixture(t),intent=await f.intent(),entered=deferred(),release=deferred()
 const request=new Request('https://cyntch.test/api/mobile/bootstrap')
 const active=f.lib.guardNativeKioskRequest(f.db,request,f.owner,f.scope.sessionId,async()=>{entered.resolve();await release.promise;return Response.json({ok:true})})
 await entered.promise
 try{await assert.rejects(f.accept(intent),{status:429})}finally{release.resolve();await active}
 await f.accept(intent)
 for(const session of [f.scope.sessionId,'sess_another'])await assert.rejects(f.lib.guardNativeKioskRequest(f.db,request,f.owner,session,async()=>assert.fail('Deleted account handler ran')),{status:410,code:'account_deletion_pending'})
 assert.equal((await f.lib.guardNativeKioskRequest(f.db,request,f.other,'sess_other',async()=>Response.json({ok:true}))).status,200)
 await assert.rejects(f.lib.readNativeKiosk(f.db,f.owner,f.scope.sessionId,f.scope.deviceId,f.secret),{status:410})
 await assert.rejects(f.lib.enforceRequestLimit(f.owner,'read'),{status:410})
 await f.lib.enforceRequestLimit(f.other,'read')
})
test('the account tombstone prevents cached identity sync, new memberships and resurrection',options,async t=>{
 const f=await fixture(t);await f.accept(await f.intent())
 await assert.rejects(f.lib.ensureCurrentUserRecord(),{status:410,code:'account_deletion_pending'})
 await assert.rejects(f.db.query('update users set full_name=$2 where id=$1',[f.owner,'Restored']),{code:'P7601'})
 await assert.rejects(f.db.query("insert into household_members(household_id,user_id,role) values($1,$2,'member')",[f.shared,f.owner]),{code:'P7601'})
 await assert.rejects(f.db.query("insert into households(name,leader_id) values('Resurrected',$1)",[f.owner]),{code:'P7601'})
 await f.db.query('delete from users where id=$1',[f.owner])
 await assert.rejects(f.db.query('insert into users(id) values($1)',[f.owner]),{code:'P7601'})
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.other])).rowCount,1)
})
test('concurrent profile and membership writes respect the exclusive acceptance lock',options,async t=>{
 const f=await fixture(t),client=await f.db.connect()
 try{
  await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[f.lib.accountAccessKey(f.owner)])
  await assert.rejects(f.db.query('update users set full_name=$2 where id=$1',[f.owner,'Race']),{code:'P7602'})
  await assert.rejects(f.db.query("insert into household_members(household_id,user_id,role) values($1,$2,'member') on conflict do nothing",[f.shared,f.owner]),{code:'P7602'})
 }finally{await client.query('rollback');client.release()}
 await f.lib.ensureCurrentUserRecord()
})

test('web preferences, household writes and household admission reject an accepted deletion',options,async t=>{
 const f=await fixture(t),web=f.load(['lib/leader-dashboard-preferences.ts','lib/actions/member-dashboard.ts','lib/entitlements.ts','lib/household-admission.ts'],{
  'next/cache':{revalidatePath(){}},
  '@clerk/nextjs/server':{auth:async()=>f.identity,currentUser:async()=>({id:f.identity.userId,emailAddresses:[],firstName:'Parent'}),
   clerkClient:async()=>({users:{getUser:async()=>({emailAddresses:[{emailAddress:'parent@example.test',verification:{status:'verified'}}]})}})}
 })
 await web.setHideCompletedTasksPreference(f.owner,false)
 assert.equal(await web.getHideCompletedTasksPreference(f.owner),false)
 assert.deepEqual(await web.saveMemberDashboardLanePreferences(f.transfer,[f.owner,f.successor],[f.successor]),{ok:true})
 await f.accept(await f.intent())
 await assert.rejects(web.setHideCompletedTasksPreference(f.owner,true),{status:410})
 await assert.rejects(web.saveMemberDashboardLanePreferences(f.transfer,[f.successor],[f.successor]),{status:410})
 await assert.rejects(web.withHouseholdWrite(f.transfer,f.owner,async()=>assert.fail('Blocked household write ran')),{status:410})
 await assert.rejects(web.createHouseholdWithAdmission(f.owner,'New family','UTC'),{status:410})
 assert.equal(await web.getHideCompletedTasksPreference(f.owner),false,'A rejected preference save has no effect')
 await web.setHideCompletedTasksPreference(f.other,false)
 assert.equal(await web.getHideCompletedTasksPreference(f.other),false)
})

test('standalone action admission keeps acceptance out until work ends and releases after errors',options,async t=>{
 const f=await fixture(t),intent=await f.intent(),entered=deferred(),release=deferred()
 const action=f.lib.withActiveAccount(f.db,f.owner,async()=>{entered.resolve();await release.promise;throw new Error('Injected action failure')})
 const rejection=assert.rejects(action,/Injected action failure/)
 await entered.promise
 try {await assert.rejects(f.accept(intent),{status:429})}finally{release.resolve();await rejection}
 await f.accept(intent)
 await assert.rejects(f.lib.withActiveAccount(f.db,f.owner,async()=>assert.fail('Blocked action ran')),{status:410})
})

test('joining a household commits membership, invite use and notifications together and cannot run after deletion',options,async t=>{
 const f=await fixture(t),household=randomUUID(),code=randomUUID()
 await f.db.query("insert into households(id,name,leader_id) values($1,'Invitation family',$2)",[household,f.other])
 await f.db.query("insert into household_members(household_id,user_id,role) values($1,$2,'manager')",[household,f.other])
 await f.db.query("insert into household_invites(household_id,created_by,code,expires_at) values($1,$2,$3,now()+interval '1 day')",[household,f.other,code])
 const pushed=[],web=f.load(['lib/actions/household.ts'],{'next/cache':{revalidatePath(){}},'next/navigation':{redirect(){throw new Error('Unexpected redirect')}},
  '@/lib/push':{dispatchPushForNotificationIds:async ids=>pushed.push(...ids)}})
 await f.db.query("create function fail_join_notification() returns trigger language plpgsql as $$ begin if new.kind='member_joined_via_link' then raise exception 'Injected notification failure'; end if; return new; end $$; create trigger fail_join_notification before insert on notification_events for each row execute function fail_join_notification()")
 await assert.rejects(web.acceptInviteByCode(code,f.owner),/Injected notification failure/)
 assert.equal((await f.db.query('select 1 from household_members where household_id=$1 and user_id=$2',[household,f.owner])).rowCount,0)
 assert.equal((await f.db.query('select uses_count from household_invites where code=$1',[code])).rows[0].uses_count,0)
 assert.equal(pushed.length,0)
 await f.db.query('drop trigger fail_join_notification on notification_events')
 await web.acceptInviteByCode(code,f.owner)
 await web.acceptInviteByCode(code,f.owner)
 assert.equal((await f.db.query('select uses_count from household_invites where code=$1',[code])).rows[0].uses_count,1)
 assert.equal((await f.db.query("select 1 from notification_events where household_id=$1 and kind='member_joined_via_link'",[household])).rowCount,1)
 assert.equal(pushed.length,1)
 await f.accept(await f.intent())
 await assert.rejects(web.acceptInviteByCode(code,f.owner),{status:410})
 assert.equal((await f.db.query('select 1 from household_members where household_id=$1 and user_id=$2',[household,f.owner])).rowCount,0)
})

test('an autocommit entitlement grant delayed after identity verification cannot recreate personal data',options,async t=>{
 const f=await fixture(t),email='daniel@nexusaspyre.com'
 await f.db.query('update users set email=$2 where id=$1',[f.owner,email])
 const lib=f.load(['lib/entitlements.ts'],{'@clerk/nextjs/server':{clerkClient:async()=>({users:{getUser:async()=>({emailAddresses:[{emailAddress:email,verification:{status:'verified'}}]})}})}})
 const client=await f.db.connect(),entered=deferred(),release=deferred()
 const delayed={query:async(...args)=>{
  if(typeof args[0]==='string'&&args[0].includes('insert into owner_entitlements')){entered.resolve();await release.promise}
  return client.query(...args)
 }}
 const grant=lib.ensurePermanentOwnerGrant(f.owner,delayed)
 const rejection=assert.rejects(grant,{status:410})
 await entered.promise
 try {await f.accept(await f.intent())}finally{release.resolve();try{await rejection}finally{client.release()}}
 assert.equal((await f.db.query('select 1 from owner_entitlements where user_id=$1',[f.owner])).rowCount,0)
})
