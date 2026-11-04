/* eslint-disable @typescript-eslint/no-require-imports -- Real native transport, PostgreSQL permissions and quotas. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs')
const next={'next/server':{NextResponse:{json:Response.json},after(){}}}

test('native one-off boards and structured run edits enforce real roles, quotas, kiosk and notifications', {skip:!connectionString}, async t=>{
  const f=await fixture(t),{POST}=f.load(['app/api/leader/flow/route.ts'],next),{MobileApi}=f.load(['mobile/src/services/api.ts'])
  await f.db.query("update household_billing set paid_through=now()+interval '5 days' where household_id=$1",[f.transfer])
  const original=global.fetch
  global.fetch=async(url,init)=>{assert.equal(new URL(url).origin,'https://fixture.cyntch.test');return POST(new Request(url,init))}
  t.after(()=>{global.fetch=original})
  const api=new MobileApi('https://fixture.cyntch.test',f.owner,f.scope.deviceId,async()=>'fixture',async()=>f.secret,f.scope.sessionId)
  const send=body=>api.request('/api/leader/flow',{householdId:f.transfer,...body})
  const create={action:'createTaskBoard',title:'Weekend jobs',creationId:randomUUID()}
  const first=await send(create),run=first.occurrence.id
  assert.equal(first.occurrence.kind,'manual')
  const task={action:'createTask',taskId:randomUUID(),occurrenceId:run,title:'Pack bag',notes:'Lunch and water',isReward:false,
    assigneeIds:[f.successor],prerequisiteIds:[],creationId:randomUUID()}
  const created=await send(task)
  assert.equal(created.occurrenceTaskStatus.status,'unlocked')
  const events=async()=> (await f.db.query("select kind,subject,member_ids from native_notification_events where household_id=$1 order by event_key",[f.transfer])).rows
  const before=await events()
  assert.equal(before.filter(row=>row.kind==='task_assigned').length,1)
  assert.equal(before.filter(row=>row.kind==='task_available').length,1)
  assert.deepEqual(await send(task),created)
  assert.deepEqual(await events(),before,'creation retries do not create fresh logical notifications')
  const edit={...task,action:'updateTask',creationId:undefined,title:'Renamed',saveStreamId:randomUUID(),saveId:randomUUID(),saveRevision:1}
  await f.db.query("update household_members set role='member' where household_id=$1 and user_id=$2",[f.transfer,f.owner])
  await assert.rejects(send(create),e=>e.status===403)
  await assert.rejects(send(edit),e=>e.status===403)
  await f.db.query("update household_members set role='supervisor' where household_id=$1 and user_id=$2",[f.transfer,f.owner])
  await f.db.query("insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array[$2],array[$2],$6,$6)",[randomUUID(),f.owner,f.scope.sessionId,f.scope.deviceId,f.transfer,'b'.repeat(64)])
  await assert.rejects(send(create),e=>e.status===423)
  await assert.rejects(send(edit),e=>e.status===423)
  await f.db.query('delete from native_kiosk_sessions where user_id=$1',[f.owner])
  assert.equal((await send(edit)).task.title,'Renamed')
  await assert.rejects(send({...edit,householdId:f.deleting,assigneeIds:[f.owner],saveRevision:2}),e=>e.status===404)
  await assert.rejects(send({...task,taskId:randomUUID(),creationId:randomUUID(),assigneeIds:[f.other]}),e=>e.status===400)
  await f.db.query("update household_billing set subscription_status='canceled',stripe_subscription_id=null,paid_through=now()-interval '1 day' where household_id=$1",[f.transfer])
  assert.deepEqual(await send(create),first,'a committed board remains recoverable after downgrade')
  await assert.rejects(send({...create,creationId:randomUUID()}),e=>e.status===402)
  await assert.rejects(send({...task,taskId:randomUUID(),creationId:randomUUID()}),e=>e.status===402,'Free cannot add to standalone boards')
  const changed={...edit,title:'Retained after downgrade',saveId:randomUUID(),saveRevision:2}
  assert.equal((await send(changed)).task.title,changed.title,'existing manual task metadata remains editable after downgrade')
  await assert.rejects(send({...changed,saveRevision:3,timing:{unlockRule:{kind:'fixed',date:'2035-01-01',time:'08:00'},expiryRule:null,unlockCombiner:'and'}}),e=>e.status===402)
  const routine=(await f.db.query('select id from routines where household_id=$1 limit 1',[f.transfer])).rows[0].id
  const templateTask=randomUUID()
  await f.db.query("insert into tasks(id,household_id,routine_id,title,created_by) values($1,$2,$3,'Keep template',$4)",[templateTask,f.transfer,routine,f.owner])
  await assert.rejects(send({...changed,taskId:templateTask,saveRevision:4}),e=>e.status===400,'occurrence quota path cannot mutate a template')
  assert.equal((await f.db.query('select title from tasks where id=$1',[templateTask])).rows[0].title,'Keep template')
})

test('native timing edits preserve untouched instants and apply changed dates in the household timezone', {skip:!connectionString}, async t=>{
  const f=await fixture(t),{POST,GET}=f.load(['app/api/leader/flow/route.ts'],next)
  const {MobileApi,changeRunTaskTiming,runTaskDraft}=f.load(['mobile/src/services/api.ts','shared/mobile/run-timing.ts','shared/mobile/run-editor.ts'])
  await f.db.query("update household_billing set paid_through=now()+interval '5 days' where household_id=$1",[f.transfer])
  await f.db.query("update households set timezone='Australia/Sydney' where id=$1",[f.transfer])
  const original=global.fetch
  global.fetch=async(url,init)=>(init?.method==='POST'?POST:GET)(new Request(url,init))
  t.after(()=>{global.fetch=original})
  const api=new MobileApi('https://fixture.cyntch.test',f.owner,f.scope.deviceId,async()=>'fixture',async()=>f.secret,f.scope.sessionId)
  const run=(await api.request('/api/leader/flow',{action:'createTaskBoard',householdId:f.transfer,title:'Timing board',creationId:randomUUID()})).occurrence.id
  const taskId=randomUUID(),activation='2027-04-03T16:30:45.123Z',expiry='2027-04-05T03:00:00.000Z'
  const timing={unlockRule:{kind:'after_generation_days',days:10,time:'02:30'},expiryRule:{kind:'fixed',date:'2027-04-05',time:'13:00'},unlockCombiner:'and'}
  const operation=draft=>({id:randomUUID(),accountId:f.owner,householdId:f.transfer,deviceId:f.scope.deviceId,revision:++revision,deviceTimeMs:Date.now(),draft})
  let revision=0
  await api.saveRunEdit(operation({taskId,occurrenceId:run,routineId:null,isNew:true,title:'Timed task',notes:'',isReward:false,assigneeIds:[f.successor],prerequisiteIds:[],timing,unlockAtOverride:activation,expiryAtOverride:expiry}))
  let data=await api.runEditor(f.transfer,run),task=data.tasks[0]
  assert.equal(task.unlock_at,activation)
  let draft=changeRunTaskTiming(runTaskDraft(data,task),task,{...timing,expiryRule:{kind:'fixed',date:'2027-04-06',time:'09:15'}},'expiry')
  const edit=operation(draft),saved=await api.saveRunEdit(edit)
  assert.equal(saved.task.unlock_at,activation,'expiry change retains the later repeated hour, milliseconds and original activation')
  assert.equal(saved.task.expires_at,'2027-04-05T23:15:00.000Z')
  assert.equal((await api.saveRunEdit(edit)).task.unlock_at,activation,'retry cannot restart the retained relative activation')
  data=await api.runEditor(f.transfer,run);task=data.tasks[0]
  draft=changeRunTaskTiming(runTaskDraft(data,task),task,{...timing,expiryRule:task.expiry_rule,unlockCombiner:'or'},'combiner')
  const combined=await api.saveRunEdit(operation(draft))
  assert.equal(combined.task.unlock_at,activation);assert.equal(combined.task.expires_at,saved.task.expires_at)
  draft=changeRunTaskTiming(draft,task,{unlockRule:null,expiryRule:null,unlockCombiner:'and'},'all')
  const cleared=await api.saveRunEdit(operation(draft))
  assert.equal(cleared.task.unlock_at,null);assert.equal(cleared.task.expires_at,null)
  assert.equal(cleared.occurrenceTaskStatus.status,'unlocked')
})

test('flow authorizes board writes and receipt replays under the household lock', {skip:!connectionString}, async t=>{
  const f=await fixture(t),authz=f.load(['lib/household-authz.ts'])
  await f.db.query("update household_billing set paid_through=now()+interval '5 days' where household_id=$1",[f.transfer])
  let revoke=false
  const {POST}=f.load(['app/api/leader/flow/route.ts'],{...next,'@/lib/household-authz':{...authz,getHouseholdMembershipAuthz:async(...args)=>{
    const probe=await f.db.connect()
    try {
      const acquired=(await probe.query('select pg_try_advisory_lock(hashtextextended($1,0)) as acquired',[f.transfer])).rows[0].acquired
      if(acquired)await probe.query('select pg_advisory_unlock(hashtextextended($1,0))',[f.transfer])
      assert.equal(acquired,false,'membership must be read only after write admission holds the household lock')
    } finally {probe.release()}
    if(revoke)await f.db.query("update household_members set role='member' where household_id=$1 and user_id=$2",[f.transfer,f.owner])
    return authz.getHouseholdMembershipAuthz(...args)
  }}})
  const body={action:'createTaskBoard',householdId:f.transfer,title:'Admission test',creationId:randomUUID()}
  const send=()=>POST(new Request('http://localhost/api/leader/flow',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}))
  revoke=true
  assert.equal((await send()).status,403)
  assert.equal((await f.db.query('select count(*)::int n from routine_occurrences where household_id=$1',[f.transfer])).rows[0].n,0)
  await f.db.query("update household_members set role='manager' where household_id=$1 and user_id=$2",[f.transfer,f.owner])
  revoke=false
  assert.equal((await send()).status,200)
  revoke=true
  assert.equal((await send()).status,403,'a stored receipt cannot bypass a newly revoked role')
})

test('native live editor reads, revision recovery and deletion preserve scope and atomically unlock dependants', {skip:!connectionString}, async t=>{
  const f=await fixture(t),{POST,GET}=f.load(['app/api/leader/flow/route.ts'],next),{MobileApi}=f.load(['mobile/src/services/api.ts'])
  await f.db.query("update household_billing set paid_through=now()+interval '5 days' where household_id=$1",[f.transfer])
  const original=global.fetch
  global.fetch=async(url,init)=>{assert.equal(new URL(url).origin,'https://fixture.cyntch.test');return (init?.method==='POST'?POST:GET)(new Request(url,init))}
  t.after(()=>{global.fetch=original})
  const api=new MobileApi('https://fixture.cyntch.test',f.owner,f.scope.deviceId,async()=>'fixture',async()=>f.secret,f.scope.sessionId)
  const createBoard=async title=>(await api.request('/api/leader/flow',{action:'createTaskBoard',householdId:f.transfer,title,creationId:randomUUID()})).occurrence.id
  const run=await createBoard('Live editor'),otherRun=await createBoard('Other board'),source=randomUUID(),target=randomUUID(),otherTask=randomUUID()
  const change=(taskId,title,prerequisites=[],revision=1)=>({id:randomUUID(),accountId:f.owner,householdId:f.transfer,deviceId:f.scope.deviceId,revision,deviceTimeMs:Date.now(),state:'pending',attempts:0,nextAttemptMs:0,error:null,
    draft:{taskId,occurrenceId:run,routineId:null,isNew:true,title,notes:'Test notes',isReward:false,assigneeIds:[f.successor],prerequisiteIds:prerequisites}})
  await api.saveRunEdit(change(source,'First task'))
  await api.saveRunEdit(change(target,'Wait for first',[source]))
  const other=change(otherTask,'Other task');other.draft.occurrenceId=otherRun;await api.saveRunEdit(other)
  let data=await api.runEditor(f.transfer,run)
  assert.equal(data.occurrence.id,run);assert.deepEqual(new Set(data.tasks.map(task=>task.id)),new Set([source,target]))
  assert.deepEqual(data.dependencies,[{source_task_id:source,target_task_id:target}])
  assert.ok(data.tasks.every(task=>task.routine_occurrence_id===run))
  const earlier=change(target,'Earlier edit',[],10);earlier.draft.isNew=false
  await api.saveRunEdit(earlier)
  const later={...earlier,id:randomUUID(),revision:11,draft:{...earlier.draft,title:'Latest task',assigneeIds:[f.owner],prerequisiteIds:[source]}}
  await api.saveRunEdit(later)
  const recovered=await api.saveRunEdit(earlier)
  assert.equal(recovered.task.title,'Latest task');assert.deepEqual(recovered.task.assignee_ids,[f.owner]);assert.deepEqual(recovered.task.prerequisite_ids,[source])
  assert.equal(recovered.occurrenceTaskStatus.status,'locked')
  assert.throws(()=>api.saveRunEdit({...earlier,accountId:f.other}),/Sign back/)
  const routine=(await f.db.query('select id from routines where household_id=$1 limit 1',[f.transfer])).rows[0].id,template=randomUUID()
  await f.db.query("insert into tasks(id,household_id,routine_id,title,created_by) values($1,$2,$3,'Template stays',$4)",[template,f.transfer,routine,f.owner])
  await api.deleteRunTask(f.transfer,run,template)
  await api.deleteRunTask(f.transfer,otherRun,source)
  assert.equal((await f.db.query('select count(*)::int n from tasks where id=any($1::uuid[])',[[template,source]])).rows[0].n,2)
  await f.db.query("update household_members set role='member' where household_id=$1 and user_id=$2",[f.transfer,f.owner])
  await assert.rejects(api.deleteRunTask(f.transfer,run,source),e=>e.status===403)
  await assert.rejects(api.runEditor(randomUUID(),run),e=>e.status===403)
  await f.db.query("update household_members set role='manager' where household_id=$1 and user_id=$2",[f.transfer,f.owner])
  await f.db.query("update routine_occurrences set status='cancelled' where id=$1",[run])
  await assert.rejects(api.deleteRunTask(f.transfer,run,source),e=>e.status===409)
  await f.db.query("update routine_occurrences set status='active' where id=$1",[run])
  await f.db.query(`create function fail_live_unlock() returns trigger language plpgsql as $$begin raise exception 'interrupted unlock'; end$$;
    create trigger interrupt_live_unlock before update on occurrence_tasks for each row execute function fail_live_unlock()`)
  await assert.rejects(api.deleteRunTask(f.transfer,run,source),e=>e.status>=500)
  assert.equal((await f.db.query('select count(*)::int n from tasks where id=$1',[source])).rows[0].n,1)
  assert.equal((await f.db.query('select count(*)::int n from task_dependencies where source_task_id=$1',[source])).rows[0].n,1)
  await f.db.query('drop trigger interrupt_live_unlock on occurrence_tasks')
  const events=async()=>(await f.db.query('select event_key,kind from native_notification_events where household_id=$1 order by event_key',[f.transfer])).rows
  await api.deleteRunTask(f.transfer,run,source)
  const notified=await events();await api.deleteRunTask(f.transfer,run,source);assert.deepEqual(await events(),notified)
  assert.equal((await f.db.query('select status from occurrence_tasks where occurrence_id=$1 and task_id=$2',[run,target])).rows[0].status,'unlocked')
  assert.ok(notified.some(event=>event.kind==='task_available'))
  data=await api.runEditor(f.transfer,run)
  assert.deepEqual(data.tasks.map(task=>task.id),[target]);assert.deepEqual(data.dependencies,[])
  assert.equal((await api.runEditor(f.transfer,otherRun)).tasks[0].id,otherTask)
  assert.equal((await f.db.query('select title from tasks where id=$1',[template])).rows[0].title,'Template stays')
})
