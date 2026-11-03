/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL and flow route with isolated authentication. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { buildSync, transformSync } = require('esbuild')
const { Pool } = require('pg')
const url = process.env.CYNTCH_TEST_DATABASE_URL

test('schedule route preserves watermarks, rejects stale edits, replays safely and enforces downgrade/access rules', { skip: !url }, async t => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
  const schema = `schedule_test_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`create schema ${schema}`)
  const db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 6 })
  t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  await db.query(`create table users(id text primary key); create table households(id uuid primary key,timezone text);
    create table routines(id uuid primary key,household_id uuid,name text,type text,recurrence_rule text,complete_older_occurrences_on_new boolean,updated_at timestamptz default now());`)
  for (const file of ['0020_planner_creations.sql', '0021_routine_start_receipts.sql', '0022_routine_schedule_receipts.sql', '0022_routine_schedule_receipts.sql']) await db.query(readFileSync(path.resolve(__dirname, '../database', file), 'utf8'))
  const householdId = randomUUID(), otherHousehold = randomUUID(), routineId = randomUUID()
  await db.query("insert into users values ('parent'); insert into households values ('" + householdId + "','Australia/Sydney'),('" + otherHousehold + "','UTC')")
  await db.query("insert into routines(id,household_id,name,type,complete_older_occurrences_on_new) values($1,$2,'Morning','recurring',false)", [routineId, householdId])
  let automation = true, role = 'manager', kiosk = false
  const entitlement = () => ({ tier: automation ? 'premium' : 'free', limits: { automation } })
  const mocks = {
    'next/server': { NextResponse: { json: Response.json }, after() {} }, '@clerk/nextjs/server': { auth: async () => ({ userId: 'parent' }) },
    '@/lib/db': { db }, '@/lib/usage-controls': { enforceRequestLimit: async () => {} },
    '@/lib/entitlements': { getHouseholdEntitlement: async () => entitlement(), EntitlementError: class extends Error {} },
    '@/lib/schema-ensure': { ensureRoutineSchemaColumns: async () => {} }, '@/lib/user-sync': { ensureCurrentUserRecord: async () => {} },
    '@/lib/completion-operations': { CompletionOperationError: class extends Error {} },
  }
  function load(file, bundle = false) {
    const filename = path.resolve(__dirname, '..', file), loaded = new Module(filename, module)
    loaded.require = id => mocks[id] ?? (id.startsWith('@/lib/') ? {} : require(id))
    const code = bundle ? buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text : transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code
    loaded._compile(code, filename); return loaded.exports
  }
  mocks['@/lib/billing-policy'] = load('lib/billing-policy.ts', true)
  mocks['@/lib/flow-entitlements'] = load('lib/flow-entitlements.ts')
  mocks['@/shared/routine-schedule'] = load('shared/routine-schedule.ts', true)
  mocks['@/lib/recurrence'] = load('lib/recurrence.ts', true)
  mocks['@/lib/planner-creation'] = load('lib/planner-creation.ts')
  mocks['@/lib/save-routine-schedule'] = load('lib/save-routine-schedule.ts')
  const authz = load('lib/household-authz.ts')
  mocks['@/lib/household-authz'] = { ...authz, getHouseholdMembershipAuthz: async () => ({ role }),
    getHouseholdKioskSettings: async () => ({ kioskActive: kiosk, sessionTokenHash: authz.sha256('token') }) }
  const route = load('app/api/leader/flow/route.ts'), { scheduleForRoutine } = mocks['@/shared/routine-schedule']
  const current = async () => (await db.query('select * from routines where id=$1', [routineId])).rows[0]
  const empty = { rules: [], completeOlderOccurrencesOnNew: false }
  const daily = { id: randomUUID(), frequency: 'daily', interval: 1, time: '09:00', startDate: '2026-11-04' }
  const desired = { rules: [daily, { ...daily, id: randomUUID(), frequency: 'weekly', weekday: 'monday' }], completeOlderOccurrencesOnNew: true }
  const body = (baseSchedule, schedule) => ({ action: 'saveRoutineSchedule', householdId, routineId, creationId: randomUUID(), baseSchedule, schedule })
  async function send(value) { return route.POST(new Request('http://localhost/api/leader/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Save-User': 'parent', Cookie: `houseflow_kiosk_session=${householdId}:token` }, body: JSON.stringify(value) })) }
  const first = body(empty, desired), response = await send(first)
  assert.equal(response.status, 200); const saved = await response.json()
  const generatedRules = JSON.parse((await current()).recurrence_rule).map(rule => ({ ...rule, lastGeneratedAt: '2026-11-04T00:00:00.000Z' }))
  await db.query('update routines set recurrence_rule=$1 where id=$2', [JSON.stringify(generatedRules), routineId])
  const second = body(desired, { ...desired, rules: desired.rules.map(rule => ({ ...rule, time: '10:00' })) })
  assert.equal((await send(second)).status, 200, 'a scheduler watermark does not conflict with editable rules')
  assert.equal(JSON.parse((await current()).recurrence_rule)[0].lastGeneratedAt, '2026-11-04T00:00:00.000Z')
  assert.deepEqual(await (await send(first)).json(), saved)
  assert.equal(JSON.parse((await current()).recurrence_rule)[0].time, '10:00', 'old acknowledged saves never reapply obsolete rules')
  assert.equal((await send({ ...first, schedule: empty })).status, 409, 'an operation ID cannot be reused for a different body')
  assert.equal((await send(body(empty, desired))).status, 409)
  const base = scheduleForRoutine(await current())
  const concurrent = ['11:00', '12:00'].map(time => body(base, { ...base, rules: base.rules.map(rule => ({ ...rule, time })) }))
  const results = await Promise.all(concurrent.map(send)), winner = results.findIndex(result => result.status === 200)
  assert.notEqual(winner, -1)
  assert.equal(results.filter(result => result.status === 200).length, 1)
  assert.equal((await send(concurrent[1 - winner])).status, 409, 'retrying the losing concurrent edit requires review')
  const malformedBase = scheduleForRoutine(await current())
  assert.equal((await send(body(malformedBase, { ...malformedBase, rules: [{ ...daily, lastGeneratedAt: '2030-01-01T00:00:00Z' }] }))).status, 400)
  assert.equal((await send(body(malformedBase, { ...malformedBase, rules: [{ ...daily, startDate: '2026-02-30' }] }))).status, 400)
  role = 'member'; assert.equal((await send(first)).status, 403)
  role = 'supervisor'; kiosk = true; assert.equal((await send(first)).status, 423)
  kiosk = false; assert.equal((await send(first)).status, 200)
  assert.equal((await send({ ...body(empty, desired), householdId: otherHousehold })).status, 404)
  automation = false
  assert.equal((await send(body(malformedBase, desired))).status, 402)
  const reduced = { rules: [malformedBase.rules[0]], completeOlderOccurrencesOnNew: false }
  assert.equal((await send(body(malformedBase, reduced))).status, 200, 'partial removal and disabling remain available after downgrade')
  assert.equal((await send(body(reduced, { ...reduced, completeOlderOccurrencesOnNew: true }))).status, 402)
  assert.equal((await send(first)).status, 200, 'a receipt remains replayable after downgrade')
  await db.query(`create function interrupt_receipt() returns trigger language plpgsql as $$ begin raise exception 'Receipt interrupted'; end $$;
    create trigger fail_receipt before insert on planner_creations for each row execute function interrupt_receipt()`)
  const clear = body(reduced, empty)
  await assert.rejects(send(clear), /Receipt interrupted/)
  assert.deepEqual(scheduleForRoutine(await current()), reduced, 'the rule update rolls back with its receipt')
  await db.query('drop trigger fail_receipt on planner_creations')
  assert.equal((await send(clear)).status, 200)
  await db.query('delete from routines where id=$1', [routineId])
  assert.equal((await send(clear)).status, 410)
})
