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
  const db = new Pool({ connectionString: url, max: 5 })
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
  t.after(async () => {
    await db.query('delete from households where id=$1', [householdId])
    await db.query('delete from users where id=any($1::text[])', [[parent, child, stranger]])
    await db.end()
  })
  const operationFile = path.resolve(__dirname, '../lib/completion-operations.ts')
  const bundled = buildSync({ entryPoints: [operationFile], bundle: true, platform: 'node', format: 'cjs', write: false })
  const operationModule = new Module(operationFile, module)
  operationModule._compile(bundled.outputFiles[0].text, operationFile)
  let userId = parent
  class EntitlementError extends Error {}
  const mocks = {
    '@/lib/db': { db },
    '@clerk/nextjs/server': { auth: async () => ({ userId }) },
    'next/server': { NextResponse: { json: Response.json }, after: () => {} },
    '@/lib/usage-controls': { enforceRequestLimit: async () => {} },
    '@/lib/flow-entitlements': { enforceFlowEntitlements: async () => ({ tier: 'premium' }) },
    '@/lib/entitlements': { EntitlementError },
    '@/lib/user-sync': { ensureCurrentUserRecord: async () => {} },
    '@/lib/schema-ensure': { ensureRoutineSchemaColumns: async () => {} },
    '@/lib/automation-entitlements': { TASK_AUTOMATION_ALLOWED_SQL: 'true', occurrenceAutomationAllowed: async () => true },
    '@/lib/time-rules': { parseExpiryRule: () => null },
    '@/lib/notifications': { createUnlockNotifications: async () => [] },
    '@/lib/push': { dispatchPushForNotificationIds: async () => {} },
    '@/lib/completion-operations': operationModule.exports,
  }
  mocks['@/lib/household-authz'] = compile('lib/household-authz.ts', mocks)
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
  const edit = change()
  const accepted = await send(edit)
  assert.equal(accepted.status, 200)
  assert.equal(accepted.data.outcome, 'applied')
  assert.deepEqual(await send(edit), accepted, 'the actual route returns its stored receipt on retry')
  assert.equal((await send({ ...edit, completed: false })).status, 409)
  const old = change({ completed: false })
  old.clientOperation.correctedTimeMs = 1000
  old.clientOperation.deviceId = randomUUID()
  assert.equal((await send(old)).data.outcome, 'superseded')
  assert.equal((await db.query('select status from occurrence_tasks where occurrence_id=$1 and task_id=$2', [occurrenceId, taskId])).rows[0].status, 'completed')
  await db.query('delete from tasks where id=$1', [taskId])
  assert.equal((await send(change())).status, 404, 'deleted task is never recreated by an offline edit')
})
