/* eslint-disable @typescript-eslint/no-require-imports -- Actual scheduler SQL against an isolated local PostgreSQL schema. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { buildSync, transformSync } = require('esbuild')
const { Pool } = require('pg')
const url = process.env.CYNTCH_TEST_DATABASE_URL

for (const file of ['app/api/internal/recurrence/route.ts', 'app/api/leader/flow/route.ts']) {
  test(`${file}: household-time generation, watermark durability and retry across a DST gap`, { skip: !url }, async t => {
    const target = new URL(url)
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
    const schema = `recurrence_test_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: url })
    await admin.query(`create schema ${schema}`)
    const db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 5 })
    t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
    await db.query(`create type task_status as enum ('locked','unlocked','completed');
      create type occurrence_status as enum ('active','completed','cancelled');
      create table households(id uuid primary key,timezone text);
      create table routines(id uuid primary key,household_id uuid,name text,recurrence_rule text,
        complete_older_occurrences_on_new boolean default false,created_at timestamptz default now(),updated_at timestamptz default now());
      create table routine_occurrences(id uuid primary key default gen_random_uuid(),household_id uuid,routine_id uuid,kind text,title text,
        scheduled_for timestamptz,status occurrence_status,created_by text,updated_at timestamptz default now());
      create table tasks(id uuid primary key default gen_random_uuid(),household_id uuid,routine_id uuid,routine_occurrence_id uuid,assignee_id text,
        title text,description text,is_reward boolean default false,position_x integer,position_y integer,status task_status,
        scheduled_time timestamptz,unlock_rule jsonb,unlock_at timestamptz,unlock_combiner text,expiry_rule jsonb,expires_at timestamptz,
        created_by text,created_at timestamptz default now(),updated_at timestamptz default now());
      create table occurrence_tasks(occurrence_id uuid,task_id uuid,status task_status,completed_at timestamptz,updated_at timestamptz default now());
      create table task_assignees(task_id uuid,user_id text,primary key(task_id,user_id));
      create table task_dependencies(source_task_id uuid,target_task_id uuid,primary key(source_task_id,target_task_id));`)
    const householdId = randomUUID(), routineId = randomUUID()
    const schedule = { id: randomUUID(), frequency: 'daily', interval: 1, time: '02:30', startDate: '2026-03-07', lastGeneratedAt: '2026-03-07T07:30:00.000Z' }
    await db.query("insert into households values($1,'America/New_York')", [householdId])
    await db.query("insert into routines(id,household_id,name,recurrence_rule) values($1,$2,'Morning',$3)", [routineId, householdId, JSON.stringify([schedule])])
    const template = (await db.query(`insert into tasks(household_id,routine_id,title,unlock_rule,unlock_combiner,position_x,position_y)
      values($1,$2,'Pack bag','{"kind":"after_generation_days","days":1,"time":"09:00"}','and',80,90) returning id`, [householdId, routineId])).rows[0].id
    await db.query("insert into task_assignees values($1,'child')", [template])
    let failNotification = false, allowance = 100
    const mocks = {
      'next/server': { NextResponse: { json: Response.json }, after() {} },
      '@clerk/nextjs/server': {}, '@/lib/db': { db },
      '@/lib/entitlements': { getHouseholdEntitlement: async () => ({ tier: 'premium', limits: { items: 100, templates: 50, automation: true } }) },
      '@/lib/automation-entitlements': { automaticGenerationAllowance: async () => allowance, occurrenceAutomationAllowed: async () => true, TASK_AUTOMATION_ALLOWED_SQL: 'true' },
      '@/lib/notifications': { createUnlockNotifications: async () => [], createManagerNotificationEventInTransaction: async () => {
        if (failNotification) throw new Error('Interrupted generation')
        return []
      } },
    }
    for (const name of ['recurrence', 'time-rules']) {
      const filename = path.resolve(__dirname, `../lib/${name}.ts`), loaded = new Module(filename, module)
      loaded._compile(buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, filename)
      mocks[`@/lib/${name}`] = loaded.exports
    }
    const filename = path.resolve(__dirname, '..', file), loaded = new Module(filename, module)
    loaded.require = id => mocks[id] ?? (id.startsWith('@/lib/') ? {} : require(id))
    // Expose the actual private materializer only in this harness, leaving the
    // public Next route contract unchanged. SQL and date resolution are real.
    loaded._compile(transformSync(readFileSync(filename, 'utf8') + '\nexport { materializeDueRecurrences, toFixedRuleFromInstant };', { loader: 'ts', format: 'cjs' }).code, filename)
    const { materializeDueRecurrences } = loaded.exports
    assert.deepEqual(loaded.exports.toFixedRuleFromInstant(new Date('2026-03-09T04:00:00Z'), 'America/New_York'), { kind: 'fixed', date: '2026-03-09', time: '00:00' }, 'midnight remains a valid clock time when a generated expiry is saved')
    async function generate() {
      const client = await db.connect()
      try {
        await client.query('BEGIN')
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [householdId])
        await materializeDueRecurrences(client, householdId, 'parent')
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    }
    const runs = async () => (await db.query('select * from routine_occurrences order by scheduled_for')).rows
    const rules = async () => JSON.parse((await db.query('select recurrence_rule from routines where id=$1', [routineId])).rows[0].recurrence_rule)
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-03-08T07:15:00Z') })
    await generate()
    assert.equal((await runs()).length, 0, '02:30 shifts to 03:30; at 03:15 it is not due')
    t.mock.timers.setTime(Date.parse('2026-03-08T07:30:00Z'))
    failNotification = true
    await assert.rejects(generate(), /Interrupted generation/)
    assert.equal((await runs()).length, 0)
    assert.equal((await rules())[0].lastGeneratedAt, schedule.lastGeneratedAt, 'watermark rolls back with the failed run')
    failNotification = false
    await Promise.all([generate(), generate()])
    assert.equal((await runs()).length, 1, 'concurrent attempts create one run')
    assert.equal((await runs())[0].scheduled_for.toISOString(), '2026-03-08T07:30:00.000Z')
    const copied = (await db.query('select * from tasks where routine_occurrence_id is not null')).rows
    assert.equal(copied.length, 1)
    assert.equal(copied[0].unlock_at.toISOString(), '2026-03-09T13:00:00.000Z', 'task timing uses the same household calendar as recurrence')
    assert.equal(copied[0].position_x, 80)
    assert.equal((await db.query('select count(*)::int n from task_assignees')).rows[0].n, 2)
    assert.equal((await rules())[0].lastGeneratedAt, '2026-03-08T07:30:00.000Z')
    t.mock.timers.setTime(Date.parse('2026-03-08T07:45:00Z'))
    await generate()
    assert.equal((await runs()).length, 1)
    // Legacy interval rules anchor to their previous generated household date,
    // even when the next due slot is still in the future.
    await db.query('update routines set recurrence_rule=$1 where id=$2', [JSON.stringify([{ ...schedule, interval: 3, startDate: undefined, lastGeneratedAt: '2026-03-08T07:30:00.000Z' }]), routineId])
    await generate()
    assert.equal((await rules())[0].startDate, '2026-03-08')
    t.mock.timers.setTime(Date.parse('2026-03-10T12:00:00Z'))
    await generate()
    assert.equal((await runs()).length, 1)
    allowance = 0
    t.mock.timers.setTime(Date.parse('2026-03-11T06:30:00Z'))
    await generate()
    assert.equal((await runs()).length, 1, 'the existing automation/capacity gate still applies')
    allowance = 100
    await generate()
    assert.equal((await runs()).length, 2)
    assert.equal((await runs())[1].scheduled_for.toISOString(), '2026-03-11T06:30:00.000Z')
  })
}
