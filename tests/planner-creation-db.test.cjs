/* eslint-disable @typescript-eslint/no-require-imports -- Isolated PostgreSQL route integration harness. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { buildSync, transformSync } = require('esbuild')
const { Pool } = require('pg')
const url = process.env.CYNTCH_TEST_DATABASE_URL

test('planner creation routes recover lost replies at capacity, reject altered retries, and never resurrect removed items', { skip: !url }, async t => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
  const schema = `planner_test_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`create schema ${schema}`)
  const db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 5 })
  t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  await db.query(`create type task_status as enum ('locked','unlocked','completed');
    create type occurrence_status as enum ('active','completed','cancelled');
    create table users(id text primary key,email text,full_name text);
    create table households(id uuid primary key, timezone text,leader_id text);
    create table household_members(household_id uuid, user_id text);
    create table routines(id uuid primary key default gen_random_uuid(), household_id uuid, name text, type text, recurrence_rule text,
      complete_older_occurrences_on_new boolean, created_by text, updated_at timestamptz default now());
    create table routine_occurrences(id uuid primary key default gen_random_uuid(), household_id uuid, routine_id uuid, kind text, title text,
      scheduled_for timestamptz, status occurrence_status, created_by text, updated_at timestamptz default now());
    create table occurrence_tasks(occurrence_id uuid,task_id uuid,status task_status,completed_at timestamptz,updated_at timestamptz default now());
    create table tasks(id uuid primary key default gen_random_uuid(), household_id uuid, routine_id uuid, routine_occurrence_id uuid, title text, description text,
      is_reward boolean, assignee_id text, status text, created_by text, position_x integer, position_y integer, updated_at timestamptz default now(),
      unlock_rule jsonb, expiry_rule jsonb, unlock_combiner text default 'and', unlock_at timestamptz, expires_at timestamptz, scheduled_time timestamptz, created_at timestamptz default now());
    create table task_assignees(task_id uuid,user_id text, primary key(task_id,user_id));
    create table task_dependencies(source_task_id uuid,target_task_id uuid, primary key(source_task_id,target_task_id));`)
  const migration = readFileSync(path.resolve(__dirname, '../database/0020_planner_creations.sql'), 'utf8')
  await db.query(migration); await db.query(migration)
  const startMigration = readFileSync(path.resolve(__dirname, '../database/0021_routine_start_receipts.sql'), 'utf8')
  await db.query(startMigration); await db.query(startMigration)
  const boardMigration = readFileSync(path.resolve(__dirname, '../database/0040_task_board_creation_receipts.sql'), 'utf8')
  await db.query(boardMigration); await db.query(boardMigration)
  await db.query(readFileSync(path.resolve(__dirname, '../database/0017_task_edit_versions.sql'), 'utf8'))
  await db.query(readFileSync(path.resolve(__dirname, '../database/0019_occurrence_status_versions.sql'), 'utf8'))
  await db.query(readFileSync(path.resolve(__dirname, '../database/0025_native_notification_events.sql'), 'utf8'))
  const householdId = randomUUID(), taskId = randomUUID()
  await db.query("insert into users(id) values ('parent'),('other'),('child'); insert into household_members values (null,'child')")
  await db.query("insert into households values($1,'Australia/Sydney','parent')", [householdId])
  await db.query("update household_members set household_id=$1", [householdId])
  let denied = false, kiosk = false, member = true, userId = 'parent', admissionChecks = 0
  class EntitlementError extends Error { constructor(message, status) { super(message); this.status = status } }
  const mocks = {
    'next/server': { NextResponse: { json: Response.json }, after() {} },
    '@clerk/nextjs/server': { auth: async () => ({ userId }) },
    '@/lib/db': { db },
    '@/lib/usage-controls': { enforceRequestLimit: async () => {} },
    '@/lib/flow-entitlements': { enforceFlowEntitlements: async () => { admissionChecks++; if (denied) throw new EntitlementError('Capacity reached', 402); return { tier: 'free' } } },
    '@/lib/entitlements': { EntitlementError, getHouseholdEntitlement: async () => ({ tier: 'free', limits: { automation: true } }) },
    '@/lib/automation-entitlements': { TASK_AUTOMATION_ALLOWED_SQL: 'true', occurrenceAutomationAllowed: async () => true },
    '@/lib/schema-ensure': { ensureRoutineSchemaColumns: async () => {} },
    '@/lib/user-sync': { ensureCurrentUserRecord: async () => {} },
    '@/lib/household-authz': { getHouseholdMembershipAuthz: async () => member ? { role: 'manager' } : null, canPerformAction: () => true,
      getHouseholdKioskSettings: async () => ({ kioskActive: kiosk, sessionTokenHash: 'hash' }), constantTimeEqual: () => true, sha256: () => 'hash' },
    '@/lib/completion-operations': { CompletionOperationError: class CompletionOperationError extends Error {} },
  }
  function load(file) {
    const filename = path.resolve(__dirname, '..', file), loaded = new Module(filename, module)
    loaded.require = id => {
      if (mocks[id]) return mocks[id]
      if (id.startsWith('@/lib/')) return {}
      return require(id)
    }
    loaded._compile(transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code, filename)
    return loaded.exports
  }
  mocks['@/shared/scheduling'] = load('shared/scheduling.ts')
  mocks['@/shared/routine-planner-graph'] = load('shared/routine-planner-graph.ts')
  for (const name of ['planner-creation', 'routine-planner', 'task-edit-version', 'save-planner-task', 'time-rules', 'save-run-task']) mocks[`@/lib/${name}`] = load(`lib/${name}.ts`)
  const recurrenceFile = path.resolve(__dirname, '../lib/recurrence.ts'), recurrence = new Module(recurrenceFile, module)
  recurrence._compile(buildSync({ entryPoints: [recurrenceFile], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, recurrenceFile)
  mocks['@/lib/recurrence'] = recurrence.exports
  mocks['@/lib/native-kiosk-guard'] = require('./helpers/native-kiosk.cjs').loadNativeKiosk(mocks)
  const route = load('app/api/leader/flow/route.ts')
  async function send(body) {
    return route.POST(new Request('http://localhost/api/leader/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Save-User': userId, Cookie: `houseflow_kiosk_session=${householdId}:token` }, body: JSON.stringify({ ...body, householdId }) }))
  }
  const routineBody = { action: 'createRoutine', name: 'Morning', type: 'recurring', creationId: randomUUID() }
  const first = await send(routineBody)
  assert.equal(first.status, 200)
  const routineResult = await first.json(), routineId = routineResult.routine.id
  denied = true
  assert.deepEqual(await (await send(routineBody)).json(), routineResult)
  assert.equal(admissionChecks, 1, 'replay does not consume another slot or fail a now-full quota')
  assert.equal((await db.query('select count(*)::int n from routines')).rows[0].n, 1)
  assert.equal((await send({ ...routineBody, name: 'Different' })).status, 409)
  kiosk = true
  assert.equal((await send(routineBody)).status, 423, 'a receipt does not bypass app lockdown')
  kiosk = false; member = false
  assert.equal((await send(routineBody)).status, 403, 'current access remains required')
  member = true; userId = 'other'
  assert.equal((await send(routineBody)).status, 402, 'another account cannot use the parent receipt')
  userId = 'parent'; denied = false

  const scheduled = await (await send({ action: 'addRecurrenceRule', routineId })).json()
  assert.match(scheduled.rules[0].startDate, /^\d{4}-\d{2}-\d{2}$/, 'new web schedules also receive a stable anchor')
  const scheduledRule = { ...scheduled.rules[0], lastGeneratedAt: '2026-10-01T22:00:00.000Z' }
  await db.query('update routines set recurrence_rule=$1 where id=$2', [JSON.stringify([scheduledRule]), routineId])
  const rescheduled = await (await send({ action: 'updateRecurrenceRule', routineId, recurrenceRuleId: scheduledRule.id,
    rule: { time: '10:00', lastGeneratedAt: '2030-01-01T00:00:00.000Z' } })).json()
  assert.equal(rescheduled.rules[0].lastGeneratedAt, scheduledRule.lastGeneratedAt, 'client edits cannot overwrite a scheduler watermark')
  assert.equal(rescheduled.rules[0].time, '10:00')

  const timing = { unlockRule: { kind: 'after_generation_days', days: 1, time: '08:30' },
    expiryRule: { kind: 'after_unlock', amount: 2, unit: 'hours' }, unlockCombiner: 'and' }
  const taskBody = { action: 'createTask', taskId, routineId, isNew: true, title: 'Pack bag', notes: '', isReward: false,
    assigneeIds: ['child'], prerequisiteIds: [], creationId: randomUUID(), timing }
  const createdTask = await send(taskBody)
  assert.equal(createdTask.status, 200)
  const taskResult = await createdTask.json()
  denied = true
  assert.deepEqual(await (await send(taskBody)).json(), taskResult)
  assert.equal((await db.query('select count(*)::int n from tasks')).rows[0].n, 1)
  assert.equal((await db.query('select count(*)::int n from task_assignees')).rows[0].n, 1)
  assert.deepEqual(taskResult.task.unlock_rule, timing.unlockRule)
  assert.deepEqual(taskResult.task.expiry_rule, timing.expiryRule)
  assert.equal(taskResult.task.unlock_at, null, 'templates defer resolution until a run starts')
  denied = false
  const update = { ...taskBody, creationId: undefined, action: 'updateTask', isNew: false, timing: undefined, title: 'Renamed', saveStreamId: randomUUID(), saveId: randomUUID(), saveRevision: 10 }
  assert.equal((await send(update)).status, 200)
  assert.deepEqual((await db.query('select unlock_rule from tasks where id=$1', [taskId])).rows[0].unlock_rule, timing.unlockRule, 'basic edits preserve timing')
  const clear = { ...update, saveId: randomUUID(), saveRevision: 11, timing: { unlockRule: null, expiryRule: null, unlockCombiner: 'or' } }
  await db.query(`create function fail_assignment() returns trigger language plpgsql as $$ begin raise exception 'Assignment interrupted'; end $$;
    create trigger interrupt_assignment before insert on task_assignees for each row execute function fail_assignment()`)
  assert.equal((await send(clear)).status, 500)
  assert.deepEqual((await db.query('select unlock_rule from tasks where id=$1', [taskId])).rows[0].unlock_rule, timing.unlockRule, 'timing rolls back with assignments')
  await db.query('drop trigger interrupt_assignment on task_assignees')
  assert.equal((await send(clear)).status, 200, 'failed transactions do not consume a revision')
  assert.equal((await send({ ...update, timing })).status, 200, 'late saves return current state')
  const cleared = (await db.query('select * from tasks where id=$1', [taskId])).rows[0]
  assert.equal(cleared.unlock_rule, null); assert.equal(cleared.expiry_rule, null); assert.equal(cleared.unlock_combiner, 'or')
  assert.equal(cleared.position_x, taskResult.task.position_x)
  assert.equal((await send({ ...clear, saveRevision: 12, timing: { ...timing, unlockRule: { kind: 'fixed', date: '2026-02-30' } } })).status, 400)

  const startBody = { action: 'createOccurrence', routineId, creationId: randomUUID() }
  const events = async () => (await db.query('select kind,subject,member_ids from native_notification_events order by kind')).rows
  assert.deepEqual(await events(), [], 'template edits are not active task or routine events')
  const start = await send(startBody)
  assert.equal(start.status, 200)
  const started = await start.json(), occurrenceId = started.occurrence.id
  const startEvents = await events()
  assert.deepEqual(startEvents.map(row => row.kind), ['routine_started', 'task_assigned', 'task_available'])
  assert.deepEqual(startEvents.find(row => row.kind === 'task_available').member_ids, ['child'])
  denied = true
  assert.deepEqual(await (await send(startBody)).json(), started, 'lost reply replays the original server-generated start time at full quota')
  assert.deepEqual(await events(), startEvents, 'a replay cannot enqueue a second set of alerts')
  assert.equal((await db.query('select count(*)::int n from routine_occurrences')).rows[0].n, 1)
  assert.equal((await db.query('select count(*)::int n from tasks')).rows[0].n, 2)
  assert.equal((await db.query('select count(*)::int n from task_assignees')).rows[0].n, 2)
  assert.equal((await send({ ...startBody, scheduledFor: '2026-11-04T00:00:00Z' })).status, 409)
  assert.equal((await send({ ...startBody, routineId: 'invalid' })).status, 400, 'invalid IDs fail before quota SQL')
  assert.equal((await send({ ...startBody, scheduledFor: 'invalid' })).status, 400)
  kiosk = true
  assert.equal((await send(startBody)).status, 423)
  kiosk = false; denied = false
  await db.query('update routines set complete_older_occurrences_on_new=true where id=$1', [routineId])
  await db.query(`create function fail_start_receipt() returns trigger language plpgsql as $$ begin raise exception 'Interrupted start receipt'; end $$;
    create trigger interrupt_start_receipt before insert on planner_creations for each row execute function fail_start_receipt()`)
  const secondStart = { ...startBody, creationId: randomUUID(), scheduledFor: new Date(Date.parse(started.occurrence.scheduled_for) + 60000).toISOString() }
  await assert.rejects(send(secondStart), /Interrupted start receipt/)
  assert.deepEqual(await events(), startEvents, 'start and superseded alerts roll back with the failed receipt')
  assert.equal((await db.query('select count(*)::int n from routine_occurrences')).rows[0].n, 1)
  assert.equal((await db.query('select count(*)::int n from tasks')).rows[0].n, 2)
  assert.equal((await db.query('select status from routine_occurrences where id=$1', [occurrenceId])).rows[0].status, 'active', 'older-run completion rolls back with the receipt')
  await db.query('drop trigger interrupt_start_receipt on planner_creations')
  assert.equal((await send(secondStart)).status, 200)
  assert.equal((await events()).filter(row => row.kind === 'routine_superseded').length, 1)
  assert.equal((await events()).filter(row => row.kind === 'routine_completed' || row.kind === 'task_completed').length, 0)
  assert.equal((await db.query('select status from routine_occurrences where id=$1', [occurrenceId])).rows[0].status, 'completed')
  await db.query('delete from routine_occurrences where id=$1', [occurrenceId])
  assert.equal((await send(startBody)).status, 410, 'a delayed start retry never recreates a removed run')
  await db.query('delete from tasks where id=$1', [taskId])
  assert.equal((await send(taskBody)).status, 410)
  await db.query('delete from routines where id=$1', [routineId])
  assert.equal((await send(routineBody)).status, 410)
  assert.equal((await db.query('select count(*)::int n from routines')).rows[0].n, 0)

  denied = false
  await db.query(`create function fail_receipt() returns trigger language plpgsql as $$ begin raise exception 'Interrupted receipt'; end $$;
    create trigger interrupt_receipt before insert on planner_creations for each row execute function fail_receipt()`)
  const interrupted = { ...routineBody, creationId: randomUUID() }
  await assert.rejects(send(interrupted), /Interrupted receipt/)
  assert.equal((await db.query('select count(*)::int n from routines')).rows[0].n, 0, 'receipt and routine roll back together')
  await db.query('drop trigger interrupt_receipt on planner_creations')
  assert.equal((await send(interrupted)).status, 200, 'an uncommitted attempt can retry')

  await t.test('one-off board creation is atomic, replayable and never resurrects a removed board', async () => {
    const before = (await db.query('select count(*)::int n from routine_occurrences')).rows[0].n
    const eventBaseline = await events()
    const body = { action: 'createTaskBoard', title: '  Weekend jobs  ', creationId: randomUUID() }
    const createdResponse = await send(body)
    assert.equal(createdResponse.status, 200)
    const created = await createdResponse.json()
    assert.equal(created.occurrence.title, 'Weekend jobs')
    assert.equal(created.occurrence.kind, 'manual'); assert.equal(created.occurrence.routine_id, null)
    assert.equal(created.occurrence.household_id, householdId)
    denied = true
    assert.deepEqual(await (await send(body)).json(), created, 'lost reply uses the original board and server start time at full quota')
    assert.equal((await db.query('select count(*)::int n from routine_occurrences')).rows[0].n, before + 1)
    assert.equal((await send({ ...body, title: 'Different board' })).status, 409)
    assert.equal((await send({ ...body, title: 'x'.repeat(201) })).status, 400)
    assert.equal((await send({ ...body, scheduledFor: 'bad' })).status, 400)
    assert.equal((await send({ ...body, creationId: randomUUID() })).status, 402)
    kiosk = true
    assert.equal((await send(body)).status, 423, 'receipt replay does not bypass kiosk protection')
    kiosk = false; member = false
    assert.equal((await send(body)).status, 403, 'receipt replay does not bypass revoked membership')
    member = true; denied = false
    for (const migrationName of ['0020_planner_creations.sql', '0021_routine_start_receipts.sql', '0022_routine_schedule_receipts.sql', '0040_task_board_creation_receipts.sql']) {
      await db.query(readFileSync(path.resolve(__dirname, '../database', migrationName), 'utf8'))
    }
    assert.deepEqual(await (await send(body)).json(), created, 'reapplying older migrations preserves newer receipts')
    await db.query('delete from routine_occurrences where id=$1', [created.occurrence.id])
    assert.equal((await send(body)).status, 410)
    await db.query('create trigger interrupt_board_receipt before insert on planner_creations for each row execute function fail_receipt()')
    const interruptedBoard = { ...body, creationId: randomUUID() }
    await assert.rejects(send(interruptedBoard), /Interrupted receipt/)
    assert.equal((await db.query('select count(*)::int n from routine_occurrences')).rows[0].n, before, 'board and receipt roll back together')
    await db.query('drop trigger interrupt_board_receipt on planner_creations')
    assert.equal((await send(interruptedBoard)).status, 200)
    assert.deepEqual(await events(), eventBaseline, 'an empty one-off board does not pretend a routine was started')
  })

  await t.test('live board task edits atomically preserve templates, timing and task state while enforcing run boundaries', async () => {
    const board = (await (await send({action:'createTaskBoard',title:'Live edits',creationId:randomUUID()})).json()).occurrence
    const sourceId=randomUUID(), rewardId=randomUUID(), templateTask=randomUUID()
    const template=(await db.query('select id from routines limit 1')).rows[0].id
    await db.query("insert into tasks(id,household_id,routine_id,title,is_reward,status,position_x,position_y) values($1,$2,$3,'Template only',false,'locked',25,35)",[templateTask,householdId,template])
    const templateBefore=(await db.query('select * from tasks where id=$1',[templateTask])).rows[0]
    const source={action:'createTask',occurrenceId:board.id,taskId:sourceId,isNew:true,title:'Pack the bag',notes:'Lunch and water',isReward:false,assigneeIds:['child'],prerequisiteIds:[],creationId:randomUUID()}
    let response=await send(source); assert.equal(response.status,200)
    const first=await response.json()
    assert.equal(first.task.routine_id,null); assert.equal(first.task.routine_occurrence_id,board.id)
    assert.equal(first.occurrenceTaskStatus.status,'unlocked')
    denied=true
    assert.deepEqual(await (await send(source)).json(),first,'a lost live-task reply replays without creating another item')
    denied=false
    const reward={...source,taskId:rewardId,title:'Choose a story',isReward:true,prerequisiteIds:[sourceId],creationId:randomUUID()}
    response=await send(reward); assert.equal(response.status,200)
    assert.equal((await response.json()).occurrenceTaskStatus.status,'locked')
    const edit={...source,action:'updateTask',isNew:false,creationId:undefined,saveStreamId:randomUUID(),saveId:randomUUID(),saveRevision:10,
      timing:{unlockRule:{kind:'fixed',date:'2035-01-02',time:'08:00'},expiryRule:{kind:'fixed',date:'2035-01-03',time:'09:00'},unlockCombiner:'and'},
      unlockAtOverride:'2035-01-02T09:15:00+11:00',expiryAtOverride:'2035-01-03T10:30:00+11:00'}
    response=await send(edit); assert.equal(response.status,200)
    const timed=await response.json()
    assert.equal(timed.occurrenceTaskStatus.status,'locked'); assert.ok(timed.task.unlock_at); assert.ok(timed.task.expires_at)
    assert.equal(timed.task.unlock_at,new Date(edit.unlockAtOverride).toISOString()); assert.equal(timed.task.expires_at,new Date(edit.expiryAtOverride).toISOString())
    assert.equal((await send({...edit,unlockAtOverride:'invalid'})).status,400)
    const renamed={...edit,title:'Renamed live task',timing:undefined,unlockAtOverride:undefined,expiryAtOverride:undefined,saveId:randomUUID(),saveRevision:11}
    response=await send(renamed); assert.equal(response.status,200)
    const renamedResult=await response.json()
    assert.equal(renamedResult.task.unlock_at,timed.task.unlock_at); assert.equal(renamedResult.task.expires_at,timed.task.expires_at)
    assert.equal(renamedResult.task.position_x,first.task.position_x); assert.equal(renamedResult.task.position_y,first.task.position_y)
    assert.equal((await send({...renamed,taskId:templateTask,routineId:template})).status,400,'template must match the run')
    assert.equal((await send({...renamed,taskId:templateTask})).status,404,'a run ID cannot disguise a template edit')
    assert.equal((await send({...renamed,prerequisiteIds:[templateTask],saveRevision:12})).status,400,'template prerequisites cannot leak into a live board')
    assert.equal((await send({...renamed,prerequisiteIds:[rewardId],saveRevision:12})).status,400,'cycles roll back the revision claim')
    const otherRun=(await (await send({action:'createTaskBoard',title:'Other board',creationId:randomUUID()})).json()).occurrence
    assert.equal((await send({...renamed,occurrenceId:otherRun.id,saveRevision:12})).status,404,'a task cannot be edited through another run')
    const clear={...renamed,title:'Ready again',saveId:randomUUID(),saveRevision:12,timing:{unlockRule:null,expiryRule:null,unlockCombiner:'and'}}
    await db.query('create trigger interrupt_live_assignment before insert on task_assignees for each row execute function fail_assignment()')
    assert.equal((await send(clear)).status,500)
    assert.equal((await db.query('select title from tasks where id=$1',[sourceId])).rows[0].title,renamed.title)
    assert.equal((await db.query('select unlock_at from tasks where id=$1',[sourceId])).rows[0].unlock_at.toISOString(),timed.task.unlock_at)
    await db.query('drop trigger interrupt_live_assignment on task_assignees')
    response=await send(clear); assert.equal(response.status,200)
    assert.equal((await response.json()).occurrenceTaskStatus.status,'unlocked','rolled-back revision can be retried')
    response=await send(edit); assert.equal(response.status,200)
    assert.equal((await response.json()).task.title,clear.title,'an older edit cannot reapply relative/absolute timing or overwrite newer metadata')
    await db.query("update occurrence_tasks set status='completed' where occurrence_id=$1 and task_id=$2",[board.id,sourceId])
    response=await send({...clear,title:'Completed task renamed',timing:undefined,saveRevision:13,saveId:randomUUID()})
    assert.equal(response.status,200); assert.equal((await response.json()).occurrenceTaskStatus.status,'completed','metadata edit does not reopen completed task')
    assert.deepEqual((await db.query('select * from tasks where id=$1',[templateTask])).rows[0],templateBefore)
    assert.equal((await db.query('select count(*)::int n from tasks where routine_occurrence_id=$1',[otherRun.id])).rows[0].n,0)
    const checksBefore=admissionChecks
    assert.equal((await send({...source,occurrenceId:'invalid'})).status,400)
    assert.equal(admissionChecks,checksBefore,'invalid structured run edits fail before entitlement SQL')
    await db.query("update routine_occurrences set status='cancelled' where id=$1",[board.id])
    assert.equal((await send({...clear,saveRevision:14})).status,409)
    await db.query('delete from tasks where id=$1',[sourceId])
    assert.equal((await send(source)).status,410,'removed live tasks cannot be recreated by a delayed retry')
  })
})
