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
