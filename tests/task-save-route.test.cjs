/* eslint-disable @typescript-eslint/no-require-imports -- Isolated route harness, no live services. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { transformSync } = require('esbuild')

const householdId = '41147524-744a-4565-9e9c-f1e3966596d7'
const taskId = 'b98ce792-81b7-4ceb-bbb2-1a17c8134901'
const versionFile = path.resolve(__dirname, '../lib/task-edit-version.ts')
const versionModule = new Module(versionFile, module)
versionModule._compile(transformSync(fs.readFileSync(versionFile, 'utf8'), { loader: 'ts', format: 'cjs' }).code, versionFile)
const creationFile = path.resolve(__dirname, '../lib/planner-creation.ts')
const creationModule = new Module(creationFile, module)
creationModule._compile(transformSync(fs.readFileSync(creationFile, 'utf8'), { loader: 'ts', format: 'cjs' }).code, creationFile)
function setup(options = {}) {
  const queries = [], after = []
  let memberships = 0, profiles = 0
  const task = { id: taskId, title: 'Renamed', routine_occurrence_id: null }
  const client = { release() {}, async query(sql) {
    queries.push(sql.trim())
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
    if (sql.includes('select timezone')) return { rows: [{ timezone: 'Australia/Sydney' }] }
    if (sql.includes('insert into task_edit_versions')) return { rows: [], rowCount: options.stale ? 0 : 1 }
    if (sql.includes('select * from tasks')) return { rows: [task], rowCount: 1 }
    if (sql.includes('update tasks')) return { rows: [task], rowCount: 1 }
    if (options.failAssignments && sql.includes('insert into task_assignees')) throw new Error('Assignment write failed')
    return { rows: [], rowCount: 1 }
  } }
  class EntitlementError extends Error { constructor(message, status) { super(message); this.status = status } }
  const mocks = {
    'next/server': { NextResponse: { json: Response.json }, after: callback => after.push(callback) },
    '@clerk/nextjs/server': { auth: async () => ({ userId: 'user-a' }) },
    '@/lib/db': { db: { ...client, connect: async () => client } },
    '@/lib/usage-controls': { enforceRequestLimit: async () => {}, recordHouseholdUsage: async () => {}, recordHouseholdActivity: async () => {} },
    '@/lib/flow-entitlements': { enforceFlowEntitlements: async () => { if (options.denied) throw new EntitlementError('Premium required', 402); return { tier: 'premium' } } },
    '@/lib/entitlements': { EntitlementError },
    '@/lib/schema-ensure': { ensureRoutineSchemaColumns: async () => {} },
    '@/lib/user-sync': { ensureCurrentUserRecord: async () => { profiles++ } },
    '@/lib/household-authz': {
      getHouseholdMembershipAuthz: async () => { memberships++; return { role: 'manager' } },
      canPerformAction: () => true,
      getHouseholdKioskSettings: async () => ({ kioskActive: options.kiosk, sessionTokenHash: 'hash' }),
      constantTimeEqual: () => true, sha256: () => 'hash',
    },
    '@/lib/time-rules': { parseUnlockRule: () => null, parseExpiryRule: () => null, resolveUnlockAt: () => null, resolveExpiryAt: () => null },
    '@/lib/task-edit-version': versionModule.exports,
    '@/lib/planner-creation': creationModule.exports,
    '@/lib/completion-operations': { CompletionOperationError: class CompletionOperationError extends Error {} },
  }
  const filename = path.resolve(__dirname, '../app/api/leader/flow/route.ts')
  const loaded = new Module(filename, module)
  loaded.require = id => {
    if (mocks[id]) return mocks[id]
    if (id.startsWith('@/lib/')) return {}
    throw new Error(`Unexpected dependency ${id}`)
  }
  loaded._compile(transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code, filename)
  const request = new Request('http://localhost/api/leader/flow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Save-User': options.saveUser ?? 'user-a', Cookie: `houseflow_kiosk_session=${householdId}:token` }, body: JSON.stringify({ action: 'updateTask', householdId, taskId, title: 'Renamed', notes: '', assigneeIds: ['user-a'], isReward: false, saveStreamId: householdId, saveId: taskId, saveRevision: 10 }) })
  return { run: () => loaded.exports.POST(request), queries, after, memberships: () => memberships, profiles: () => profiles }
}

test('task and assignees commit together, without profile sync or duplicate membership lookup', async () => {
  const app = setup()
  const response = await app.run()
  assert.equal(response.status, 200)
  assert.equal((await response.json()).task.title, 'Renamed')
  assert.equal(app.memberships(), 1)
  assert.equal(app.profiles(), 0)
  const begin = app.queries.indexOf('BEGIN'), commit = app.queries.indexOf('COMMIT')
  assert.ok(begin >= 0 && commit > begin)
  assert.ok(app.queries.slice(begin, commit).some(sql => sql.includes('update tasks')))
  assert.ok(app.queries.slice(begin, commit).some(sql => sql.includes('insert into task_assignees')))
  assert.equal(app.after.length, 1, 'nonessential usage work runs after the response')
  assert.ok(!app.queries.some(sql => sql.includes('select id, routine_occurrence_id, unlock_rule')))
})

test('assignment failure rolls back the entire task save', async () => {
  const app = setup({ failAssignments: true })
  await assert.rejects(app.run(), /Assignment write failed/)
  assert.ok(app.queries.includes('ROLLBACK'))
  assert.ok(!app.queries.includes('COMMIT'))
})

test('a late or duplicate version returns the current task without rewriting it', async () => {
  const app = setup({ stale: true })
  assert.equal((await app.run()).status, 200)
  assert.ok(!app.queries.some(sql => sql.includes('update tasks')))
  assert.ok(app.queries.includes('COMMIT'))
})

test('restored edits cannot be replayed under another signed-in account', async () => {
  const app = setup({ saveUser: 'user-b' })
  assert.equal((await app.run()).status, 403)
  assert.equal(app.queries.length, 0)
})

test('entitlements and kiosk restrictions still apply to background saves', async () => {
  for (const [options, status] of [[{ denied: true }, 402], [{ kiosk: true }, 423]]) {
    const app = setup(options)
    assert.equal((await app.run()).status, status)
    assert.ok(!app.queries.some(sql => sql.includes('update tasks')))
  }
})
