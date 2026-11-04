/* eslint-disable @typescript-eslint/no-require-imports -- Real isolated PostgreSQL erasure, preservation, replay and rollback checks. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),options={skip:!connectionString}
async function content(f){
 const marker='PRIVATE_'+randomUUID(),routine=randomUUID(),ownRun=randomUUID(),otherRun=randomUUID(),ownTask=randomUUID(),ownTemplate=randomUUID(),otherTemplate=randomUUID(),otherTask=randomUUID(),secondOtherTask=randomUUID(),otherSnapshot=randomUUID()
 await f.db.query('update users set full_name=$2,email=$3 where id=$1',[f.owner,marker,marker+'@private.test'])
 await f.db.query("insert into routines(id,household_id,name,created_by,recurrence_rule) values($1,$2,$3,$4,'private recurrence')",[routine,f.shared,marker,f.owner])
 await f.db.query("insert into routine_occurrences(id,routine_id,household_id,scheduled_for,title,created_by) values($1,$3,$4,now(),$5,$6),($2,$3,$4,now(),'Other run',$7)",[ownRun,otherRun,routine,f.shared,marker,f.owner,f.other])
 for(const [id,run,author,title]of[[ownTask,ownRun,f.owner,marker],[ownTemplate,null,f.owner,marker],[otherTemplate,null,f.other,'Other template'],[otherTask,ownRun,f.other,'Other task'],[secondOtherTask,ownRun,f.other,'Second other task'],[otherSnapshot,otherRun,f.other,'Other snapshot']]){
  await f.db.query("insert into tasks(id,household_id,routine_id,routine_occurrence_id,title,description,created_by,status) values($1,$2,$3,$4,$5,$5,$6,'completed')",[id,f.shared,routine,run,title,author])
  if(run)await f.db.query("insert into occurrence_tasks(occurrence_id,task_id,status,completed_at) values($1,$2,'completed',now())",[run,id])
 }
 await f.db.query('insert into task_assignees(task_id,user_id) values($1,$2),($1,$3)',[otherTask,f.owner,f.other])
 await f.db.query('insert into task_dependencies(source_task_id,target_task_id) values($1,$2),($3,$2)',[otherTask,secondOtherTask,ownTask])
 const operationId=randomUUID(),version={sequence:7,correctedTimeMs:1800000000000,operationId,deviceId:f.owner+':'+f.scope.deviceId}
 await f.db.query('insert into completion_versions(occurrence_id,task_id,operation_id,device_id,sequence,corrected_time_ms) values($1,$2,$3,$4,$5,$6)',[ownRun,otherTask,operationId,version.deviceId,version.sequence,version.correctedTimeMs])
 await f.db.query('insert into completion_stream_versions(occurrence_id,task_id,device_id,sequence,corrected_time_ms) values($1,$2,$3,$4,$5)',[ownRun,otherTask,version.deviceId,version.sequence,version.correctedTimeMs])
 const event=randomUUID(),nativeEvent=randomUUID(),unrelatedEvent=randomUUID()
 await f.db.query("insert into notification_events(id,household_id,kind,actor_user_id,subject_member_user_id,metadata) values($1,$2,'member_left_household',$3,$4,$5)",[event,f.shared,f.other,f.owner,JSON.stringify({memberName:marker})])
 await f.db.query('insert into user_notifications(event_id,user_id,title,body) values($1,$2,$3,$3)',[event,f.other,marker])
 await f.db.query("insert into native_notification_events(id,household_id,event_key,kind,subject,member_ids) values($1::uuid,$2,$1::uuid::text,'task_completed',$3,array[$4])",[nativeEvent,f.shared,JSON.stringify({taskId:ownTask,name:marker}),f.owner])
 await f.db.query("insert into native_notification_events(id,household_id,event_key,kind,subject,member_ids) values($1::uuid,$2,$1::uuid::text,'task_completed',$3,array[$4])",[unrelatedEvent,f.shared,JSON.stringify({taskId:otherSnapshot,name:'Other snapshot'}),f.other])
 await f.db.query('insert into native_notification_deliveries(event_id,user_id,device_id) values($1,$2,$3)',[nativeEvent,f.other,f.otherDevice])
 const preferences={enabled:true,showDetails:false,timezone:'UTC',quietHours:null,categories:{task_completed:{enabled:true,memberIds:[f.owner,f.other]}}}
 await f.db.query('insert into native_notification_preferences(user_id,device_id,household_id,preferences) values($1,$2,$3,$4)',[f.other,f.otherDevice,f.shared,JSON.stringify(preferences)])
 await f.db.query("insert into native_notification_operations(user_id,device_id,operation_id,action,household_id,request_hash,result) values($1,$2,$3,'savePreferences',$4,$5,$6)",[f.other,f.otherDevice,randomUUID(),f.shared,'hash',JSON.stringify({settings:{preferences}})])
 await f.db.query('insert into notification_preferences(user_id,household_id,task_unlocked_other_member_ids) values($1,$2,$3)',[f.other,f.shared,JSON.stringify([f.owner,f.other])])
 await f.db.query('insert into member_dashboard_lane_preferences(user_id,household_id,visible_member_ids,editable_member_ids) values($1,$2,array[$3,$1],array[$3])',[f.other,f.shared,f.owner])
 await f.db.query("insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,'sess_other',$3,$4,array[$5],array[$5],$6,$6)",[randomUUID(),f.other,f.otherDevice,f.shared,f.owner,'b'.repeat(64)])
 await f.db.query("insert into native_notification_devices(user_id,device_id,platform,permission) values($1,$2,'android','denied')",[f.owner,f.otherDevice])
 await f.db.query("insert into native_notification_revocations(device_id,account_id,session_id) values($1,$2,'sess_old')",[f.scope.deviceId,f.owner])
 await f.db.query("insert into application_rate_limits(bucket_key,window_start) values($1,now()),($2,now())",['read:'+f.owner,'read:'+f.other])
 await f.db.query("insert into owner_entitlements(user_id,verified_email,verification_source) values($1,$2,'clerk_verified_email')",[f.owner,marker+'@private.test'])
 const creation={id:randomUUID(),action:'saveRoutineSchedule',hash:'saved-hash'}
 await f.db.query("insert into planner_creations(household_id,user_id,operation_id,action,entity_id,request_hash,result) values($1,$2,$3,$4,$5,$6,$7)",[f.shared,f.other,creation.id,creation.action,routine,creation.hash,JSON.stringify({routine:{id:routine,name:marker}})])
 const completion={isClientOperation:true,requestHash:'saved-completion',version:{operationId:randomUUID()}}
 await f.db.query('insert into completion_operations(user_id,operation_id,household_id,request_hash,result) values($1,$2,$3,$4,$5)',[f.other,completion.version.operationId,f.shared,completion.requestHash,JSON.stringify({operationId:completion.version.operationId,outcome:'applied',occurrenceTaskStatuses:[{task_id:ownTask,status:'completed'}]})])
 return {marker,routine,ownRun,otherRun,ownTask,ownTemplate,otherTemplate,otherTask,secondOtherTask,otherSnapshot,event,nativeEvent,unrelatedEvent,version,creation,completion}
}
async function claim(f,intent){
 const leaseId=randomUUID()
 await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1",[intent.operationId,leaseId])
 const work=(await f.db.query('select work from account_deletion_requests where id=$1',[intent.operationId])).rows[0].work
 return {id:intent.operationId,accountId:f.owner,leaseId,work}
}

test('account cleanup erases personal data and authored content while preserving other authors, ordering and kiosk restrictions',options,async t=>{
 const f=await fixture(t),c=await content(f),intent=await f.intent();await f.accept(intent)
 const job=await claim(f,intent)
 await f.lib.deleteAccountData(f.db,job)
 for(const id of [f.owner,f.child])assert.equal((await f.db.query('select 1 from users where id=$1',[id])).rowCount,0)
 for(const id of [f.other,f.successor,f.sharedChild])assert.equal((await f.db.query('select 1 from users where id=$1',[id])).rowCount,1)
 assert.equal((await f.db.query('select 1 from routines where id=$1',[c.routine])).rowCount,0)
 assert.equal((await f.db.query('select 1 from routine_occurrences where id=$1',[c.ownRun])).rowCount,0)
 assert.equal((await f.db.query('select 1 from tasks where id=any($1::uuid[])',[[c.ownTask,c.ownTemplate]])).rowCount,0)
 const tasks=(await f.db.query('select * from tasks where id=any($1::uuid[])',[[c.otherTask,c.secondOtherTask,c.otherTemplate,c.otherSnapshot]])).rows
 assert.equal(tasks.length,4);assert.ok(tasks.every(task=>task.created_by===f.other&&task.description.startsWith(task.title)))
 const keptRun=(await f.db.query('select * from routine_occurrences where id=$1',[c.otherRun])).rows[0]
 assert.equal(keptRun.routine_id,null);assert.equal(keptRun.kind,'manual');assert.equal(keptRun.title,'Other run')
 const moved=tasks.find(task=>task.id===c.otherTask)
 assert.notEqual(moved.routine_occurrence_id,c.ownRun)
 const version=(await f.db.query('select * from completion_versions where task_id=$1',[c.otherTask])).rows[0]
 assert.equal(version.occurrence_id,moved.routine_occurrence_id);assert.equal(Number(version.corrected_time_ms),c.version.correctedTimeMs)
 assert.equal(Number(version.sequence),c.version.sequence);assert.match(version.device_id,/^retired:/)
 assert.equal((await f.db.query('select 1 from completion_stream_versions where task_id=$1',[c.otherTask])).rowCount,0)
 assert.equal((await f.db.query('select 1 from task_dependencies where source_task_id=$1 and target_task_id=$2',[c.otherTask,c.secondOtherTask])).rowCount,1)
 assert.deepEqual((await f.db.query('select user_id from task_assignees where task_id=$1',[c.otherTask])).rows.map(row=>row.user_id),[f.other])
 assert.equal((await f.db.query('select status from occurrence_tasks where task_id=$1',[c.otherTask])).rows[0].status,'completed')
 assert.equal((await f.db.query('select 1 from native_notification_events where id=$1',[c.unrelatedEvent])).rowCount,1)
 assert.equal((await f.db.query('select 1 from native_notification_events where id=$1',[c.nativeEvent])).rowCount,0)
 assert.equal((await f.db.query('select 1 from user_notifications where event_id=$1',[c.event])).rowCount,0)
 const prefs=(await f.db.query('select preferences from native_notification_preferences where user_id=$1',[f.other])).rows[0].preferences
 assert.deepEqual(prefs.categories.task_completed.memberIds,[f.other])
 const kiosk=await f.lib.readNativeKiosk(f.db,f.other,'sess_other',f.otherDevice,f.secret)
 assert.equal(kiosk.kiosk.state,'locked');assert.deepEqual(kiosk.kiosk.visibleMemberIds,[])
 assert.deepEqual(f.lib.parseNativeKioskSession(kiosk.kiosk).visibleMemberIds,[])
 assert.equal(f.lib.restrictKioskBoard({household:{id:f.shared},members:[{id:f.other}],tasks:[],fetchedAt:''},kiosk.kiosk).members.length,0)
 assert.throws(()=>f.lib.parseKioskOperation({...kiosk.kiosk,action:'activate',exitSecret:'a'.repeat(64)}),'New empty locks remain invalid')
 await assert.rejects(f.lib.findPlannerCreation(f.db,f.shared,f.other,c.creation),{status:410})
 await assert.rejects(f.lib.findCompletionReceipt(f.db,f.other,c.completion),{status:410})
 assert.equal((await f.db.query('select 1 from planner_creations where operation_id=$1',[c.creation.id])).rowCount,1,'Keep the anti-replay receipt')
 assert.equal((await f.db.query('select 1 from native_notification_installations where device_id=$1',[f.scope.deviceId])).rowCount,0)
 assert.equal((await f.accept(intent)).requestId,intent.operationId,'An acknowledgement lost until after cleanup still replays')
 assert.equal((await f.db.query('select 1 from native_notification_installations where device_id=$1',[f.scope.deviceId])).rowCount,0,'Receipt replay must not recreate an erased installation')
 assert.equal((await f.db.query('select 1 from native_notification_installations where device_id=$1',[f.otherDevice])).rowCount,1,'Keep a shared installation for its other account')
 await f.lib.revokeNativeNotificationSession(f.scope.deviceId,f.secret,f.owner,'sess_late')
 assert.equal((await f.db.query('select 1 from native_notification_revocations where account_id=$1',[f.owner])).rowCount,0,'Late sign-out cannot recreate erased references')
 for(const table of ['users','routines','routine_occurrences','tasks','notification_events','user_notifications','native_notification_events','native_notification_changes','native_notification_preferences','native_notification_operations','native_kiosk_sessions','member_dashboard_lane_preferences','planner_creations','completion_operations','completion_versions','completion_stream_versions','owner_entitlements','application_rate_limits']){
  const dump=JSON.stringify((await f.db.query(`select * from ${table}`)).rows)
  assert.equal(dump.includes(c.marker),false,table+' kept an erased name')
  assert.equal(dump.includes(f.owner),false,table+' kept the original account ID')
 }
 const counts=(await f.db.query('select (select count(*) from routines) as templates,(select count(*) from routine_occurrences) as runs')).rows[0]
 await f.lib.deleteAccountData(f.db,job)
 assert.deepEqual((await f.db.query('select (select count(*) from routines) as templates,(select count(*) from routine_occurrences) as runs')).rows[0],counts,'Retry must not recreate replacement containers')
})

test('data cleanup validates its durable lease and cannot use a caller-supplied scope',options,async t=>{
 const f=await fixture(t),intent=await f.intent();await f.accept(intent);const job=await claim(f,intent)
 for(const wrong of [{...job,leaseId:randomUUID()},{...job,accountId:f.other},{...job,id:randomUUID()}])await assert.rejects(f.lib.deleteAccountData(f.db,wrong),{code:'data_cleanup_failed'})
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,1)
 await f.db.query("update account_deletion_requests set lease_until=now()-interval '1 second' where id=$1",[job.id])
 await assert.rejects(f.lib.deleteAccountData(f.db,job),{code:'data_cleanup_failed'})
 await f.db.query("update account_deletion_requests set lease_until=now()+interval '60 seconds' where id=$1",[job.id])
 await f.lib.deleteAccountData(f.db,{...job,work:{...job.work,orphanProfileIds:[f.other],householdIds:[f.shared]}})
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.other])).rowCount,1)
})

test('a cleanup interruption rolls back content moves and retries through the durable coordinator',options,async t=>{
 const f=await fixture(t),c=await content(f),intent=await f.intent();await f.accept(intent)
 await f.db.query("create function fail_erasure() returns trigger language plpgsql as $$ begin if old.id like 'user_delete_%' then raise exception 'Injected delete failure'; end if; return old; end $$; create trigger fail_erasure before delete on users for each row execute function fail_erasure()")
 const adapters={data:job=>f.lib.deleteAccountData(f.db,job),stripe:async()=>{throw new f.lib.AccountDeletionProcessingError('stripe_cleanup_failed')},native:async()=>assert.fail('Native cleanup should not run'),identity:async()=>assert.fail('Identity cleanup should not run')}
 assert.equal((await f.lib.processAccountDeletions(f.db,adapters)).retrying,1)
 assert.equal((await f.db.query('select 1 from routines where id=$1',[c.routine])).rowCount,1)
 assert.equal((await f.db.query('select routine_occurrence_id from tasks where id=$1',[c.otherTask])).rows[0].routine_occurrence_id,c.ownRun)
 assert.equal((await f.db.query("select (work->'phases'->>'data')::boolean as done from account_deletion_requests")).rows[0].done,false)
 await f.db.query('drop trigger fail_erasure on users')
 await f.db.query("update account_deletion_requests set next_attempt_at=now()-interval '1 second'")
 assert.equal((await f.lib.processAccountDeletions(f.db,adapters)).retrying,1)
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,0)
 const request=(await f.db.query('select state,work,last_error_code from account_deletion_requests')).rows[0]
 assert.equal(request.state,'pending');assert.equal(request.work.phases.data,true);assert.equal(request.work.phases.stripe,false)
 assert.equal(request.last_error_code,'stripe_cleanup_failed')
})

test('a local profile adopted by another household after acceptance is preserved',options,async t=>{
 const f=await fixture(t),intent=await f.intent();await f.accept(intent)
 await f.db.query("insert into household_members(household_id,user_id,role) values($1,$2,'member')",[f.shared,f.child])
 await f.lib.deleteAccountData(f.db,await claim(f,intent))
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.child])).rowCount,1)
 assert.equal((await f.db.query('select 1 from household_members where household_id=$1 and user_id=$2',[f.shared,f.child])).rowCount,1)
})

test('an exhausted data-phase budget rolls back earlier erasure and leaves the connection reusable',options,async t=>{
 const f=await fixture(t),c=await content(f),intent=await f.intent();await f.accept(intent)
 const job=await claim(f,intent);let elapsed=0,erasureReached=false
 const pool={connect:async()=>{
  const client=await f.db.connect()
  return new Proxy(client,{get(target,key){
   if(key==='query')return async(text,values)=>{const result=await target.query(text,values);if(text==='delete from users where id=any($1::text[])'){erasureReached=true;elapsed=100}return result}
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
 }}
 await assert.rejects(f.lib.deleteAccountData(pool,job,50,()=>elapsed),{code:'cleanup_pending'})
 assert.equal(erasureReached,true)
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,1)
 assert.equal((await f.db.query('select routine_occurrence_id from tasks where id=$1',[c.otherTask])).rows[0].routine_occurrence_id,c.ownRun)
 await f.lib.deleteAccountData(f.db,job)
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,0)
 for(const budget of [0,-1,NaN,40_001])await assert.rejects(f.lib.deleteAccountData(f.db,job,budget),{code:'data_cleanup_failed'})
})

test('PostgreSQL cancels a blocked cleanup statement within the phase budget',options,async t=>{
 const f=await fixture(t),intent=await f.intent();await f.accept(intent);const job=await claim(f,intent)
 const blocker=await f.db.connect()
 try{
  await blocker.query('begin');await blocker.query('select id from account_deletion_requests where id=$1 for update',[job.id])
  // The adapter's ordinary lock timeout is two seconds. A shorter shared
  // statement budget must cancel the query in PostgreSQL, not leave it running.
  await assert.rejects(f.lib.deleteAccountData(f.db,job,1000),{code:'57014'})
 }finally{await blocker.query('rollback');blocker.release()}
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,1)
 await f.lib.deleteAccountData(f.db,job)
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,0)
})

test('late web preferences cannot restore a deleted member and pending purchases retain their household reservation',options,async t=>{
 const f=await fixture(t),purchase=randomUUID()
 await f.db.query("insert into billing_purchase_attempts(id,household_id,user_id,session_id,device_id,provider,environment,billing_interval,expires_at,integration_suffix) values($1,$2,$3,$4,$5,'play_store','sandbox','monthly',now()+interval '1 day','testdemo')",[purchase,f.transfer,f.owner,f.scope.sessionId,f.scope.deviceId])
 const intent=await f.intent();await f.accept(intent);await f.lib.deleteAccountData(f.db,await claim(f,intent))
 f.identity.userId=f.other;f.identity.sessionId='sess_other_web'
 const web=f.load(['app/api/notifications/preferences/route.ts'],{'next/server':{NextResponse:{json:Response.json}}})
 const response=await web.POST(new Request('https://cyntch.test/api/notifications/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({householdId:f.shared,taskUnlockedOtherEnabled:true,taskUnlockedOtherMemberIds:[f.owner,f.other,f.successor],rewardUnlockedOtherMemberIds:[f.owner]})}))
 assert.equal(response.status,200)
 const preferences=(await response.json()).preferences
 assert.deepEqual(preferences.task_unlocked_other_member_ids,[f.other]);assert.deepEqual(preferences.reward_unlocked_other_member_ids,[])
 const lanes=f.load(['lib/actions/member-dashboard.ts'],{'next/cache':{revalidatePath(){}}})
 assert.deepEqual(await lanes.saveMemberDashboardLanePreferences(f.shared,[f.owner,f.other],[f.owner]),{ok:true})
 assert.deepEqual((await f.db.query('select visible_member_ids from member_dashboard_lane_preferences where user_id=$1',[f.other])).rows[0].visible_member_ids,[f.other])
 const reservation=(await f.db.query('select * from billing_purchase_attempts where id=$1',[purchase])).rows[0]
 assert.equal(reservation.state,'reserved');assert.equal(reservation.household_id,f.transfer)
 assert.equal(reservation.user_id,'deleted');assert.equal(reservation.session_id,'deleted')
 assert.notEqual(reservation.device_id,f.scope.deviceId)
})

test('legacy membership notifications gain traceable subjects or lose only untraceable display-name copies',options,async t=>{
 const f=await fixture(t),joined=randomUUID(),left=randomUUID(),fs=require('node:fs'),path=require('node:path')
 for(const [id,kind,actor]of[[joined,'member_joined_via_link',f.owner],[left,'member_left_household',f.other]]){
  await f.db.query('insert into notification_events(id,household_id,kind,actor_user_id,metadata) values($1,$2,$3,$4,$5)',[id,f.shared,kind,actor,JSON.stringify({memberName:'Old untraceable name',householdName:'Family'})])
  await f.db.query("insert into user_notifications(event_id,user_id,title,body) values($1,$2,'Membership changed','Old untraceable name left')",[id,f.other])
 }
 const migration=fs.readFileSync(path.resolve(__dirname,'../database/0035_account_data_cleanup.sql'),'utf8')
 await f.db.query(migration);await f.db.query(migration)
 assert.equal((await f.db.query('select subject_member_user_id from notification_events where id=$1',[joined])).rows[0].subject_member_user_id,f.owner)
 const legacy=(await f.db.query('select metadata from notification_events where id=$1',[left])).rows[0].metadata
 assert.deepEqual(legacy,{householdName:'Family'})
 assert.equal((await f.db.query('select body from user_notifications where event_id=$1',[left])).rows[0].body,'Household membership changed.')
 assert.equal((await f.db.query('select 1 from notification_events where id=$1',[left])).rowCount,1)
})

test('a preference save cannot outlive validation and restore a member removed by deletion',options,async t=>{
 const f=await fixture(t),intent=await f.intent()
 let enter,release;const entered=new Promise(resolve=>{enter=resolve}),resume=new Promise(resolve=>{release=resolve})
 const proxy=new Proxy(f.db,{get(target,key){
  if(key==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(inner,property){
   if(property==='query')return async(...args)=>{const result=await inner.query(...args);if(typeof args[0]==='string'&&args[0].includes('select user_id,role from household_members')){enter();await resume}return result}
   const value=Reflect.get(inner,property);return typeof value==='function'?value.bind(inner):value
  }})}
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
 }})
 f.identity.userId=f.other;f.identity.sessionId='sess_other_web'
 const web=f.load(['app/api/notifications/preferences/route.ts'],{'@/lib/db':{db:proxy,kioskGateDb:f.db},'next/server':{NextResponse:{json:Response.json}}})
 const saving=web.POST(new Request('https://cyntch.test/api/notifications/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({householdId:f.shared,taskUnlockedOtherEnabled:true,taskUnlockedOtherMemberIds:[f.owner]})}))
 await entered
 try {await assert.rejects(f.accept(intent),{status:429})}finally{release();assert.equal((await saving).status,200)}
 const fresh=await f.intent();await f.accept(fresh);await f.lib.deleteAccountData(f.db,await claim(f,fresh))
 assert.deepEqual((await f.db.query('select task_unlocked_other_member_ids from notification_preferences where user_id=$1',[f.other])).rows[0].task_unlocked_other_member_ids,[])
})
