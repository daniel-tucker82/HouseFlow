/* eslint-disable @typescript-eslint/no-require-imports -- Route integration against isolated PostgreSQL. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync, readdirSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { transformSync, buildSync } = require('esbuild')
const { Pool } = require('pg')
const url = process.env.CYNTCH_TEST_DATABASE_URL

function compile(relative, dependencies) {
  const filename = path.resolve(__dirname, '..', relative)
  const loaded = new Module(filename, module)
  loaded.require = name => dependencies[name] ?? (name.startsWith('@/lib/') ? {} : require(name))
  loaded._compile(transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code, filename)
  return loaded.exports
}

test('F01 O05 O07 native completion endpoint enforces real membership, prerequisites, cancellation and replay rules', { skip: !url }, async t => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
  const schema = `completion_route_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`create schema ${schema}`)
  const db = new Pool({ connectionString: url, max: 5, options: `-c search_path=${schema}` })
  const kioskGateDb = new Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` })
  t.after(async () => { await Promise.all([db.end(), kioskGateDb.end()]); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  // The historical migrations detect enum names globally. Clone their labels
  // into this test schema so existing public fixture types cannot redirect DDL.
  for (const name of ['app_role', 'routine_type', 'task_status', 'occurrence_status', 'notification_kind']) {
    const labels = (await admin.query(`select e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace
      where t.typname=$1 and n.nspname='public' order by e.enumsortorder`, [name])).rows
    if (labels.length) await db.query(`create type ${name} as enum (${labels.map(row => "'" + row.enumlabel.replaceAll("'", "''") + "'").join(',')})`)
  }
  const migrations = path.resolve(__dirname, '../database')
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) await db.query(readFileSync(path.join(migrations, file), 'utf8'))
  const householdId = randomUUID(), occurrenceId = randomUUID(), taskId = randomUUID(), prerequisiteId = randomUUID(), deviceId = randomUUID()
  const parent = `test-parent-${randomUUID()}`, child = `test-child-${randomUUID()}`, stranger = `test-stranger-${randomUUID()}`
  await db.query('insert into users(id) values ($1),($2),($3)', [parent, child, stranger])
  await db.query("insert into households(id,name,leader_id,timezone) values ($1,'Native route test',$2,'Australia/Sydney')", [householdId, parent])
  await db.query("insert into household_members(household_id,user_id,role) values ($1,$2,'manager'),($1,$3,'member')", [householdId, parent, child])
  await db.query("insert into routine_occurrences(id,household_id,kind,title,scheduled_for) values ($1,$2,'manual','Test board',now())", [occurrenceId, householdId])
  for (const id of [prerequisiteId, taskId]) {
    await db.query("insert into tasks(id,household_id,routine_occurrence_id,title,status) values ($1,$2,$3,'Task','unlocked')", [id, householdId, occurrenceId])
    await db.query("insert into occurrence_tasks(occurrence_id,task_id,status) values ($1,$2,'unlocked')", [occurrenceId, id])
    await db.query('insert into task_assignees(task_id,user_id) values ($1,$2)', [id, child])
  }
  const operationFile = path.resolve(__dirname, '../lib/completion-operations.ts')
  const bundled = buildSync({ entryPoints: [operationFile], bundle: true, platform: 'node', format: 'cjs', write: false })
  const operationModule = new Module(operationFile, module)
  operationModule._compile(bundled.outputFiles[0].text, operationFile)
  let userId = parent, sessionId = null
  class EntitlementError extends Error {}
  const mocks = {
    '@/lib/db': { db, kioskGateDb },
    '@clerk/nextjs/server': { auth: async () => ({ userId, sessionId }) },
    'next/server': { NextResponse: { json: Response.json }, after: () => {} },
    '@/lib/usage-controls': { enforceRequestLimit: async () => {} },
    '@/lib/flow-entitlements': { enforceFlowEntitlements: async () => ({ tier: 'premium', limits: { automation: true } }) },
    '@/lib/entitlements': { EntitlementError },
    '@/lib/user-sync': { ensureCurrentUserRecord: async () => {} },
    '@/lib/schema-ensure': { ensureRoutineSchemaColumns: async () => {} },
    '@/lib/automation-entitlements': { TASK_AUTOMATION_ALLOWED_SQL: 'true', occurrenceAutomationAllowed: async () => true },
    '@/lib/notifications': { createUnlockNotifications: async () => [] },
    '@/lib/push': { dispatchPushForNotificationIds: async () => {} },
    '@/lib/completion-operations': operationModule.exports,
  }
  mocks['@/lib/household-authz'] = compile('lib/household-authz.ts', mocks)
  mocks['@/lib/planner-creation'] = compile('lib/planner-creation.ts', mocks)
  mocks['@/lib/task-edit-version'] = compile('lib/task-edit-version.ts', mocks)
  mocks['@/shared/scheduling'] = compile('shared/scheduling.ts', mocks)
  mocks['@/lib/time-rules'] = compile('lib/time-rules.ts', mocks)
  const kiosk = require('./helpers/native-kiosk.cjs').loadNativeKiosk(mocks)
  mocks['@/lib/native-kiosk-guard'] = kiosk
  const route = compile('app/api/leader/flow/route.ts', mocks)
  let sequence = 0
  function change(values = {}) {
    return { action: 'setOccurrenceTaskCompleted', householdId, occurrenceId, taskId, actorMemberId: child, completed: true,
      clientOperation: { id: randomUUID(), deviceId, sequence: ++sequence, correctedTimeMs: Date.now() }, ...values }
  }
  async function send(body, account = userId) {
    const response = await route.POST(new Request('http://localhost/api/mobile/completions', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Task-Save-User': account }, body: JSON.stringify(body) }))
    return { status: response.status, data: await response.json() }
  }

  assert.equal((await send(change(), stranger)).status, 403, 'queued changes cannot cross accounts')
  userId = stranger
  assert.equal((await send(change())).status, 403, 'non-member cannot edit')
  userId = child
  assert.equal((await send(change({ actorMemberId: parent }))).status, 403, 'member cannot pretend to act for another member')
  userId = parent
  await db.query('insert into task_dependencies(source_task_id,target_task_id) values ($1,$2)', [prerequisiteId, taskId])
  const locked = await send(change())
  assert.equal(locked.status, 409)
  assert.match(locked.data.error, /not startable/)
  await db.query('delete from task_dependencies where target_task_id=$1', [taskId])
  await db.query("update routine_occurrences set status='cancelled' where id=$1", [occurrenceId])
  assert.equal((await send(change())).status, 409)
  await db.query("update routine_occurrences set status='active' where id=$1", [occurrenceId])
  await db.query('delete from native_notification_events')
  const edit = change()
  const accepted = await send(edit)
  assert.equal(accepted.status, 200)
  assert.equal(accepted.data.outcome, 'applied')
  assert.match(accepted.data.occurrenceTaskStatuses.find(task => task.task_id === taskId).status_version, /^\d+$/)
  assert.deepEqual(await send(edit), accepted, 'retry preserves the outcome and unchanged statuses')
  const completionEvents = (await db.query('select kind,member_ids from native_notification_events')).rows
  assert.deepEqual(completionEvents, [{ kind: 'task_completed', member_ids: [child] }], 'manual boards emit task completion once, without claiming routine completion')
  assert.equal((await send({ ...edit, completed: false })).status, 409)
  const old = change({ completed: false })
  old.clientOperation.correctedTimeMs = 1000
  old.clientOperation.deviceId = randomUUID()
  assert.equal((await send(old)).data.outcome, 'superseded')
  assert.deepEqual((await db.query('select kind,member_ids from native_notification_events')).rows, completionEvents, 'rejected and superseded edits produce no alerts')
  assert.equal((await db.query('select status from occurrence_tasks where occurrence_id=$1 and task_id=$2', [occurrenceId, taskId])).rows[0].status, 'completed')
  const reopened = await send(change({ completed: false }))
  const current = reopened.data.occurrenceTaskStatuses.find(task => task.task_id === taskId)
  const original = accepted.data.occurrenceTaskStatuses.find(task => task.task_id === taskId)
  assert.ok(BigInt(current.status_version) > BigInt(original.status_version))
  const replayed = await send(edit)
  assert.equal(replayed.data.outcome, 'applied', 'retry does not change the recorded operation outcome')
  assert.deepEqual(replayed.data.occurrenceTaskStatuses, reopened.data.occurrenceTaskStatuses, 'retry returns current state, not the original stale snapshot')
  assert.equal((await db.query("select count(*)::int n from native_notification_events where kind='task_reopened'")).rows[0].n, 1)
  assert.equal((await db.query('select count(*)::int as count from completion_operations where operation_id=$1', [edit.clientOperation.id])).rows[0].count, 1)
  await db.query('delete from tasks where id=$1', [taskId])
  assert.ok(!(await send(edit)).data.occurrenceTaskStatuses.some(task => task.task_id === taskId), 'replayed receipt cannot recreate a removed task')
  assert.equal((await send(change())).status, 404, 'deleted task is never recreated by an offline edit')

  await db.query('delete from native_notification_events')
  const create = { action: 'createTask', householdId, occurrenceId, title: 'Future task', assigneeIds: [child],
    unlockRule: { kind: 'fixed', date: '2090-01-01', time: '09:00' } }
  const future = await send(create)
  assert.equal(future.status, 200)
  assert.equal(future.data.occurrenceTaskStatus.status, 'locked')
  assert.deepEqual((await db.query('select kind from native_notification_events')).rows, [{ kind: 'task_assigned' }],
    'a future task is never announced as available between insertion and recalculation')
  await db.query('delete from native_notification_events')
  const update = { ...create, action: 'updateTask', taskId: future.data.task.id, unlockRule: null, assigneeIds: [parent] }
  assert.equal((await send(update)).status, 200)
  assert.deepEqual((await db.query('select kind,member_ids from native_notification_events order by kind')).rows,
    [{ kind: 'task_assigned', member_ids: [parent] }, { kind: 'task_available', member_ids: [parent] }],
    'availability reflects the final assignee set, without transient assignment alerts')
  assert.equal((await send({ action: 'deleteTask', householdId, occurrenceId, taskId: future.data.task.id })).status, 200)
  assert.equal((await db.query('select count(*)::int n from tasks where id=$1', [future.data.task.id])).rows[0].n, 0)

  await db.query('delete from native_notification_events')
  await db.query(`create function interrupt_native_task() returns trigger language plpgsql as $$ begin raise exception 'Interrupted task creation'; end $$;
    create trigger fail_native_task before insert on occurrence_tasks for each row execute function interrupt_native_task()`)
  await assert.rejects(send({ ...create, title: 'Must roll back' }), /Interrupted task creation/)
  assert.equal((await db.query("select count(*)::int n from tasks where title='Must roll back'")).rows[0].n, 0)
  assert.equal((await db.query('select count(*)::int n from native_notification_events')).rows[0].n, 0)
  await db.query('drop trigger fail_native_task on occurrence_tasks')
  sessionId = 'sess_kiosk_route'
  const kioskId = randomUUID(), exitSecret = 'b'.repeat(64), installationSecret = 'a'.repeat(64)
  await kiosk.saveNativeKiosk(db, parent, sessionId, deviceId, installationSecret, { action: 'activate', id: kioskId,
    householdId, visibleMemberIds: [child], editableMemberIds: [child], exitSecret })
  const permitted = await send(change({ taskId: prerequisiteId }))
  assert.equal(permitted.status, 200, JSON.stringify(permitted.data))
  assert.equal(permitted.data.outcome, 'applied')
  assert.equal((await db.query('select status from occurrence_tasks where occurrence_id=$1 and task_id=$2', [occurrenceId, prerequisiteId])).rows[0].status, 'completed')
  assert.equal((await send(create)).status, 423, 'locked parent cannot create tasks')
  assert.equal((await send(change({ taskId: prerequisiteId, completed: false, actorMemberId: parent }))).status, 403)
  assert.equal((await send(change({ taskId: prerequisiteId, completed: false }))).status, 200, 'kiosk supports completing and reopening tasks')
  await kiosk.saveNativeKiosk(db, parent, sessionId, deviceId, installationSecret, { action: 'unlock', id: kioskId, exitSecret })
  await kiosk.saveNativeKiosk(db, parent, sessionId, deviceId, installationSecret, { action: 'activate', id: randomUUID(),
    householdId, visibleMemberIds: [child], editableMemberIds: [], exitSecret })
  assert.equal((await send(change({ taskId: prerequisiteId }))).status, 403, 'read-only kiosk cannot complete tasks')
})
