/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL commit, rollback and concurrency tests. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync, readdirSync } = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')
const url = process.env.CYNTCH_TEST_DATABASE_URL

async function fixture(t) {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
  const schema = `native_events_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`create schema ${schema}`)
  const db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 6 })
  t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  for (const name of ['app_role', 'routine_type', 'task_status', 'occurrence_status', 'notification_kind']) {
    const labels = (await admin.query(`select e.enumlabel from pg_enum e join pg_type p on p.oid=e.enumtypid join pg_namespace n on n.oid=p.typnamespace
      where p.typname=$1 and n.nspname='public' order by e.enumsortorder`, [name])).rows
    if (labels.length) await db.query(`create type ${name} as enum (${labels.map(row => "'" + row.enumlabel.replaceAll("'", "''") + "'").join(',')})`)
  }
  const dir = path.resolve(__dirname, '../database')
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) await db.query(readFileSync(path.join(dir, file), 'utf8'))
  await db.query(readFileSync(path.join(dir, '0025_native_notification_events.sql'), 'utf8'))
  const household = randomUUID(), routine = randomUUID()
  await db.query("insert into users(id,email,full_name) values ('user_parent','parent@example.test','Parent'),('local_child',null,'Alex'),('user_joined','joined@example.test','Taylor')")
  await db.query("insert into households(id,name,leader_id) values ($1,'Family','user_parent')", [household])
  await db.query("insert into household_members(household_id,user_id,role) values ($1,'user_parent','manager')", [household])
  await db.query("insert into routines(id,household_id,name) values($1,$2,'Morning routine')", [routine, household])
  async function transaction(work) {
    const client = await db.connect()
    try { await client.query('begin'); const result = await work(client); await client.query('commit'); return result }
    catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
  const events = async () => (await db.query('select * from native_notification_events order by occurred_at,id')).rows
  const clear = () => db.query('delete from native_notification_events')
  async function run(createdVia = 'manual', reward = true) {
    const occurrence = randomUUID(), tasks = [randomUUID(), randomUUID()]
    await transaction(async client => {
      await client.query("insert into routine_occurrences(id,household_id,routine_id,kind,title,scheduled_for,created_via) values($1,$2,$3,'routine','Run',now(),$4)", [occurrence, household, routine, createdVia])
      for (const [index, task] of tasks.entries()) {
        await client.query("insert into tasks(id,household_id,routine_id,routine_occurrence_id,title,is_reward) values($1,$2,$3,$4,$5,$6)", [task, household, routine, occurrence, index ? 'Play' : 'Pack bag', Boolean(index && reward)])
        await client.query("insert into occurrence_tasks(occurrence_id,task_id,status) values($1,$2,$3)", [occurrence, task, index && reward ? 'locked' : 'unlocked'])
        await client.query("insert into task_assignees(task_id,user_id) values($1,'local_child')", [task])
      }
    })
    return { occurrence, tasks }
  }
  return { db, household, routine, transaction, run, events, clear }
}

test('all native notification events commit with net task/routine/member changes and retain final assignments', { skip: !url }, async t => {
  const f = await fixture(t), seen = new Set()
  async function kinds() { const rows = await f.events(); rows.forEach(row => seen.add(row.kind)); return rows.map(row => row.kind).sort() }
  assert.deepEqual(await kinds(), [], 'creating a household does not notify its creator that they joined')
  await f.db.query("insert into household_members(household_id,user_id,role) values($1,'local_child','member'),($1,'user_joined','member')", [f.household])
  assert.deepEqual(await kinds(), ['member_added', 'member_joined'])
  assert.equal((await f.events()).find(row => row.kind === 'member_added').subject.name, 'Alex')
  await f.db.query("insert into household_members(household_id,user_id,role) values($1,'user_joined','member') on conflict do nothing", [f.household])
  assert.equal((await f.events()).length, 2, 'invitation replay is a no-op')
  await f.clear()
  await f.transaction(async client => {
    await client.query("delete from household_members where household_id=$1 and user_id='user_joined'", [f.household])
    await client.query("insert into household_members(household_id,user_id,role) values($1,'user_joined','member')", [f.household])
  })
  assert.deepEqual(await kinds(), [], 'temporary membership replacement does not leave/join')
  await f.db.query("delete from household_members where household_id=$1 and user_id='user_joined'", [f.household])
  assert.deepEqual(await kinds(), ['member_left'])
  await f.clear()
  const first = await f.run()
  assert.deepEqual(await kinds(), ['routine_started', 'task_assigned', 'task_assigned', 'task_available'])
  assert.ok((await f.events()).filter(row => row.kind.startsWith('task_')).every(row => row.member_ids.length === 1 && row.member_ids[0] === 'local_child'))
  await f.clear()
  await f.transaction(async client => {
    await client.query("update occurrence_tasks set status='completed',completion_reason='manual' where task_id=$1", [first.tasks[0]])
    await client.query("update occurrence_tasks set status='unlocked' where task_id=$1", [first.tasks[1]])
  })
  assert.deepEqual(await kinds(), ['reward_available', 'task_completed'])
  await f.clear()
  await f.db.query("update occurrence_tasks set status='completed',completion_reason='manual' where task_id=$1", [first.tasks[1]])
  assert.deepEqual(await kinds(), ['reward_completed', 'routine_completed'], 'effective completion includes timer-style writers which leave ro.status active')
  await f.clear()
  await f.db.query("update occurrence_tasks set status='unlocked',completion_reason=null where task_id=$1", [first.tasks[0]])
  assert.deepEqual(await kinds(), ['routine_reopened', 'task_available', 'task_reopened'])
  await f.clear()
  await f.db.query("update occurrence_tasks set status='completed',completion_reason='expiry' where task_id=$1", [first.tasks[0]])
  assert.deepEqual(await kinds(), ['routine_completed', 'task_completed_automatically'])
  const older = await f.run('manual', false)
  await f.clear()
  await f.transaction(async client => {
    await client.query("update occurrence_tasks set status='completed',completion_reason='newer_copy' where occurrence_id=$1", [older.occurrence])
    await client.query("update routine_occurrences set status='completed',completion_reason='newer_copy' where id=$1", [older.occurrence])
  })
  assert.deepEqual(await kinds(), ['routine_superseded'], 'automatic replacement does not also claim manual task/routine completion')
  await f.clear(); await f.run('recurrence')
  assert.ok((await kinds()).includes('routine_generated'))
  assert.equal((await f.db.query('select count(*)::int n from native_notification_changes')).rows[0].n, 0)
  assert.equal(seen.size, 15)
})

test('new assignments to available tasks alert only the added people, and locked reopens are not startable', { skip: !url }, async t => {
  const f = await fixture(t), run = await f.run('manual', false)
  await f.clear()
  await f.db.query("insert into task_assignees(task_id,user_id) values($1,'user_parent')", [run.tasks[0]])
  assert.deepEqual((await f.events()).map(row => ({ kind: row.kind, members: row.member_ids })).sort((a, b) => a.kind.localeCompare(b.kind)),
    [{ kind: 'task_assigned', members: ['user_parent'] }, { kind: 'task_available', members: ['user_parent'] }])
  await f.db.query("update occurrence_tasks set status='completed' where task_id=$1", [run.tasks[0]])
  await f.clear()
  await f.db.query("update occurrence_tasks set status='locked',completion_reason=null where task_id=$1", [run.tasks[0]])
  assert.deepEqual((await f.events()).map(row => row.kind), ['task_reopened'])
})

test('a full 100-task run commits one routine completion with its task events', { skip: !url }, async t => {
  const f = await fixture(t), occurrence = randomUUID()
  await f.transaction(async client => {
    await client.query("insert into routine_occurrences(id,household_id,routine_id,kind,scheduled_for) values($1,$2,$3,'routine',now())", [occurrence, f.household, f.routine])
    await client.query(`with created as (
      insert into tasks(household_id,routine_id,routine_occurrence_id,title,assignee_id)
      select $1,$2,$3,'Task ' || n,'local_child' from generate_series(1,100) n returning id
    ) insert into occurrence_tasks(occurrence_id,task_id,status) select $3,id,'unlocked' from created`, [f.household, f.routine, occurrence])
  })
  await f.clear()
  const start = performance.now()
  await f.transaction(async client => {
    await client.query('select id from routine_occurrences where id=$1 for update', [occurrence])
    await client.query("update occurrence_tasks set status='completed',completion_reason='manual' where occurrence_id=$1", [occurrence])
  })
  t.diagnostic(`Local PostgreSQL: 100-task completion and durable events committed in ${(performance.now() - start).toFixed(1)} ms; not a physical-device UX measurement.`)
  const events = await f.events()
  assert.equal(events.filter(row => row.kind === 'task_completed').length, 100)
  assert.equal(events.filter(row => row.kind === 'routine_completed').length, 1)
  assert.equal((await f.db.query('select count(*)::int n from native_notification_changes')).rows[0].n, 0)
})

test('native events roll back, ignore transient states and removals, and serialize simultaneous final tasks', { skip: !url }, async t => {
  const f = await fixture(t), run = await f.run('manual', false)
  await f.clear()
  await assert.rejects(f.transaction(async client => {
    await client.query("update occurrence_tasks set status='completed' where task_id=$1", [run.tasks[0]])
    throw new Error('Interrupted transaction')
  }), /Interrupted/)
  assert.equal((await f.events()).length, 0)
  await f.transaction(async client => {
    await client.query("update occurrence_tasks set status='completed' where task_id=$1", [run.tasks[0]])
    await client.query("update occurrence_tasks set status='unlocked' where task_id=$1", [run.tasks[0]])
    await client.query("delete from task_assignees where task_id=$1", [run.tasks[0]])
    await client.query("insert into task_assignees values($1,'local_child',now())", [run.tasks[0]])
  })
  assert.equal((await f.events()).length, 0, 'status/assignment recalculation with no net change emits nothing')
  await Promise.all(run.tasks.map(task => f.transaction(async client => {
    await client.query('select id from routine_occurrences where id=$1 for update', [run.occurrence])
    await client.query("update occurrence_tasks set status='completed',completion_reason='manual' where task_id=$1", [task])
  })))
  const complete = await f.events()
  assert.equal(complete.filter(row => row.kind === 'task_completed').length, 2)
  assert.equal(complete.filter(row => row.kind === 'routine_completed').length, 1)
  await f.clear()
  await f.db.query("update occurrence_tasks set status='completed' where occurrence_id=$1", [run.occurrence])
  assert.equal((await f.events()).length, 0, 'replaying identical writes cannot duplicate events')
  await f.transaction(async client => {
    await client.query("update occurrence_tasks set status='unlocked' where occurrence_id=$1", [run.occurrence])
    await client.query('delete from routine_occurrences where id=$1', [run.occurrence])
  })
  assert.equal((await f.events()).length, 0, 'a deleted run does not emit stale reopen notifications')
  await f.transaction(async client => {
    await client.query("insert into household_members(household_id,user_id,role) values($1,'local_child','member')", [f.household])
    await client.query('delete from households where id=$1', [f.household])
  })
  assert.equal((await f.events()).length, 0)
  assert.equal((await f.db.query('select count(*)::int n from native_notification_changes')).rows[0].n, 0)
})
