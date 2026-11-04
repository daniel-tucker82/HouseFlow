/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL run-history reads behind mocked authentication. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { transformSync, buildSync } = require('esbuild')
const { Pool } = require('pg')
const url = process.env.CYNTCH_TEST_DATABASE_URL

test('run history pages accurately, retains microsecond ordering, isolates households and never mutates completion state', { skip: !url }, async t => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
  const schema = `runs_test_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`create schema ${schema}`)
  const db = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  await db.query(`create table users(id text primary key,full_name text,email text,avatar_url text);
    create table households(id uuid primary key,name text,timezone text,leader_id text);
    create table household_members(household_id uuid,user_id text,role text,token_color text);
    create table routines(id uuid primary key,household_id uuid,name text);
    create table routine_occurrences(id uuid primary key,routine_id uuid,household_id uuid,kind text,title text,scheduled_for timestamptz,status text);
    create table tasks(id uuid primary key,household_id uuid,title text,description text,is_reward boolean,unlock_at timestamptz,expires_at timestamptz,created_at timestamptz default now());
    create table occurrence_tasks(occurrence_id uuid,task_id uuid,status text,status_version bigint default 1);
    create table task_assignees(task_id uuid,user_id text); create table task_dependencies(source_task_id uuid,target_task_id uuid)`)
  for (let i = 0; i < 2; i++) await db.query(readFileSync(path.resolve(__dirname, '../database/0023_run_history_index.sql'), 'utf8'))
  const hh = randomUUID(), other = randomUUID(), template = randomUUID(), old = [], active = randomUUID(), empty = randomUUID(), foreign = randomUUID()
  await db.query("insert into users(id,full_name) values('parent','Parent'),('child','Alex')")
  await db.query("insert into households values($1,'Family','Australia/Sydney','parent'),($2,'Other','UTC','other')", [hh, other])
  await db.query("insert into household_members values($1,'parent','manager',null),($1,'child','member',null)", [hh])
  await db.query("insert into routines values($1,$2,'Morning')", [template, hh])
  for (let i = 0; i < 28; i++) {
    const id = randomUUID(), task = randomUUID(); old.push(id)
    // Distinct microseconds and equal timestamps both occur across the page boundary.
    const time = i < 24 ? '2026-11-01T00:00:00.123457Z' : '2026-11-01T00:00:00.123456Z'
    await db.query("insert into routine_occurrences values($1,$2,$3,'routine',$4,$5,$6)", [id, template, hh, `Recurrence - ${randomUUID()}`, time, i === 0 ? 'active' : 'completed'])
    await db.query("insert into tasks(id,household_id,title,is_reward) values($1,$2,'Pack bag',false)", [task, hh])
    await db.query("insert into occurrence_tasks values($1,$2,'completed',10)", [id, task])
    await db.query("insert into task_assignees values($1,'child')", [task])
  }
  await db.query("insert into routine_occurrences values($1,$2,$3,'routine',null,now(),'active'),($4,null,$3,'manual','Shopping',now(),'active'),($5,null,$6,'manual','Private',now(),'completed')", [active, template, hh, empty, foreign, other])
  const source = randomUUID(), targetTask = randomUUID()
  await db.query("insert into tasks(id,household_id,title,is_reward,unlock_at) values($1,$3,'First',false,null),($2,$3,'Then',true,'2030-01-01')", [source, targetTask, hh])
  await db.query("insert into occurrence_tasks values($1,$2,'unlocked',4),($1,$3,'locked',5);", [active, source, targetTask])
  await db.query('insert into task_dependencies values($1,$2)', [source, targetTask])
  await db.query("insert into task_assignees values($1,'child')", [source])
  let userId = 'parent'
  const mocks = { '@/lib/db': { db }, '@clerk/nextjs/server': { auth: async () => ({ userId }) },
    '@/lib/household-authz': { normalizeRole: role => role === 'leader' ? 'manager' : role }, '@/lib/usage-controls': { enforceRequestLimit: async () => {} },
    '@/lib/entitlements': { EntitlementError: class extends Error {} } }
  function load(relative, bundle = false) {
    const filename = path.resolve(__dirname, '..', relative), loaded = new Module(filename, module)
    loaded.require = id => mocks[id] ?? require(id)
    const code = bundle ? buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text : transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code
    loaded._compile(code, filename); return loaded.exports
  }
  mocks['@/shared/scheduling'] = load('shared/scheduling.ts', true)
  mocks['@/lib/mobile-runs'] = load('lib/mobile-runs.ts')
  mocks['@/lib/native-kiosk-guard'] = require('./helpers/native-kiosk.cjs').loadNativeKiosk(mocks)
  const route = load('app/api/mobile/runs/route.ts')
  const send = params => route.GET(new Request(`http://localhost/api/mobile/runs?${new URLSearchParams({ householdId: hh, ...params })}`))
  const first = await (await send({ view: 'past' })).json()
  assert.equal(first.items.length, 25); assert.ok(first.nextCursor)
  assert.ok(first.items.every(run => run.title === 'Morning' && run.completed_tasks === 1 && run.status === 'completed'))
  const second = await (await send({ view: 'past', cursor: first.nextCursor })).json()
  assert.equal(second.items.length, 3); assert.equal(second.nextCursor, null)
  assert.deepEqual(new Set([...first.items, ...second.items].map(run => run.id)), new Set(old))
  assert.equal((await send({ cursor: 'bad' })).status, 400)
  assert.equal((await send({ cursor: Buffer.from(JSON.stringify({ time: '2026-02-30T00:00:00.000000Z', id: old[0] })).toString('base64url') })).status, 400)
  assert.equal((await send({ householdId: 'not-a-uuid' })).status, 400)
  assert.equal((await send({ view: 'invalid' })).status, 400)
  const activePage = await (await send({ view: 'active' })).json()
  assert.deepEqual(new Set(activePage.items.map(run => run.id)), new Set([active, empty]))
  const detailResponse = await send({ occurrenceId: active }), detail = await detailResponse.json()
  assert.equal(detailResponse.headers.get('cache-control'), 'no-store')
  assert.equal(detail.tasks.find(task => task.id === targetTask).blocking_task_title, 'First')
  assert.equal(detail.tasks.find(task => task.id === targetTask).blocking_task_id, source)
  assert.deepEqual(detail.tasks.find(task => task.id === targetTask).blocking_task_assignee_ids, ['child'])
  const { overlayRunMetadata } = load('shared/mobile/run-metadata.ts', true)
  const preview = overlayRunMetadata(detail, [{ householdId: hh, state: 'pending', draft: {
    occurrenceId: active, taskId: source, title: 'Renamed first task', notes: '', isReward: false, assigneeIds: ['parent'], isNew: false,
  } }])
  assert.equal(preview.tasks.find(task => task.id === targetTask).blocking_task_title, 'Renamed first task')
  assert.deepEqual(preview.tasks.find(task => task.id === targetTask).blocking_task_assignee_ids, ['parent'])
  assert.equal(preview.tasks.find(task => task.id === targetTask).status, 'locked')
  assert.equal(detail.tasks.find(task => task.id === targetTask).lock_type, 'prerequisite')
  assert.equal(detail.tasks.find(task => task.id === targetTask).status_version, '5')
  assert.equal(detail.household.timezone, 'Australia/Sydney')
  userId = 'child'
  const childDetail = await (await send({ occurrenceId: old[0] })).json()
  assert.equal(childDetail.household.role, 'member'); assert.deepEqual(childDetail.tasks[0].assignee_ids, ['child'])
  assert.equal((await send({ householdId: other })).status, 403)
  assert.equal((await send({ occurrenceId: foreign })).status, 404)
  assert.equal((await send({ occurrenceId: randomUUID() })).status, 404)
  assert.equal((await db.query('select status_version from occurrence_tasks where task_id=$1', [targetTask])).rows[0].status_version, '5')
  await db.query("delete from household_members where household_id=$1 and user_id='child'", [hh])
  assert.equal((await send({ view: 'past' })).status, 403)
  userId = null; assert.equal((await send({})).status, 401)
})
