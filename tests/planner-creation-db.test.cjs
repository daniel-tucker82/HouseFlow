/* eslint-disable @typescript-eslint/no-require-imports -- Isolated PostgreSQL route integration harness. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { transformSync } = require('esbuild')
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
  await db.query(`create table users(id text primary key);
    create table households(id uuid primary key, timezone text);
    create table household_members(household_id uuid, user_id text);
    create table routines(id uuid primary key default gen_random_uuid(), household_id uuid, name text, type text, recurrence_rule text,
      complete_older_occurrences_on_new boolean, created_by text, updated_at timestamptz default now());
    create table tasks(id uuid primary key, household_id uuid, routine_id uuid, routine_occurrence_id uuid, title text, description text,
      is_reward boolean, assignee_id text, status text, created_by text, position_x integer, position_y integer, updated_at timestamptz default now());
    create table task_assignees(task_id uuid,user_id text);
    create table task_dependencies(source_task_id uuid,target_task_id uuid);`)
  const migration = readFileSync(path.resolve(__dirname, '../database/0020_planner_creations.sql'), 'utf8')
  await db.query(migration); await db.query(migration)
  const householdId = randomUUID(), taskId = randomUUID()
  await db.query("insert into users values ('parent'),('other'); insert into household_members values (null,'child')")
  await db.query("insert into households values($1,'Australia/Sydney')", [householdId])
  await db.query("update household_members set household_id=$1", [householdId])
  let denied = false, kiosk = false, member = true, userId = 'parent', admissionChecks = 0
  class EntitlementError extends Error { constructor(message, status) { super(message); this.status = status } }
  const mocks = {
    'next/server': { NextResponse: { json: Response.json }, after() {} },
    '@clerk/nextjs/server': { auth: async () => ({ userId }) },
    '@/lib/db': { db },
    '@/lib/usage-controls': { enforceRequestLimit: async () => {} },
    '@/lib/flow-entitlements': { enforceFlowEntitlements: async () => { admissionChecks++; if (denied) throw new EntitlementError('Capacity reached', 402); return { tier: 'free' } } },
    '@/lib/entitlements': { EntitlementError, getHouseholdEntitlement: async () => ({ tier: 'free' }) },
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
  for (const name of ['planner-creation', 'routine-planner', 'task-edit-version', 'save-planner-task']) mocks[`@/lib/${name}`] = load(`lib/${name}.ts`)
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

  const taskBody = { action: 'createTask', taskId, routineId, isNew: true, title: 'Pack bag', notes: '', isReward: false,
    assigneeIds: ['child'], prerequisiteIds: [], creationId: randomUUID() }
  const createdTask = await send(taskBody)
  assert.equal(createdTask.status, 200)
  const taskResult = await createdTask.json()
  denied = true
  assert.deepEqual(await (await send(taskBody)).json(), taskResult)
  assert.equal((await db.query('select count(*)::int n from tasks')).rows[0].n, 1)
  assert.equal((await db.query('select count(*)::int n from task_assignees')).rows[0].n, 1)
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
})
