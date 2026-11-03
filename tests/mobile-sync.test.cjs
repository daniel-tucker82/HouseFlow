/* eslint-disable @typescript-eslint/no-require-imports -- Runs the mobile storage layer against real SQLite in Node. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function load(files) {
  const filename = path.resolve(__dirname, 'native-test-entry.cjs')
  // One module graph preserves class identity (including transport errors) across the services.
  const contents = files.map(relative => `export * from ${JSON.stringify(path.resolve(__dirname, '..', relative))};`).join('\n')
  const { outputFiles } = buildSync({ stdin: { contents, resolveDir: __dirname }, bundle: true, platform: 'node', format: 'cjs', write: false })
  const loadedModule = new Module(filename)
  loadedModule.paths = require.resolve.paths('esbuild')
  loadedModule._compile(outputFiles[0].text, filename)
  return loadedModule.exports
}
const { LocalStore, SyncEngine, TransportError, BoardController, nextSyncDelay, estimateClockOffset, compareCompletionVersions,
  notificationCatalog, defaultNotificationPreferences, shouldPushNotification, inQuietHours } = load([
  'mobile/src/storage/local-store.ts', 'mobile/src/storage/sync-engine.ts', 'mobile/src/services/board-controller.ts',
  'shared/mobile/sync-policy.ts', 'shared/mobile/notification-catalog.ts',
])

class SqliteAdapter {
  constructor(filename) { this.database = new DatabaseSync(filename); this.tail = Promise.resolve(); this.failOnBoardWrite = false }
  async execAsync(sql) { this.database.exec(sql) }
  async runAsync(sql, ...values) {
    if (this.failOnBoardWrite && sql.includes('INSERT INTO board_snapshots')) throw new Error('Simulated disk write failure')
    return this.database.prepare(sql).run(...values)
  }
  async getFirstAsync(sql, ...values) { return this.database.prepare(sql).get(...values) ?? null }
  async getAllAsync(sql, ...values) { return this.database.prepare(sql).all(...values) }
  async withExclusiveTransactionAsync(work) {
    const run = this.tail.then(async () => {
      this.database.exec('BEGIN IMMEDIATE')
      try { await work(this); this.database.exec('COMMIT') }
      catch (error) { this.database.exec('ROLLBACK'); throw error }
    })
    this.tail = run.catch(() => {})
    return run
  }
  close() { this.database.close() }
}
function snapshot() {
  return { household: { id: 'h1', name: 'Family', timezone: 'Australia/Sydney', leaderId: 'parent', role: 'manager' },
    members: [], fetchedAt: '2026-11-03T00:00:00Z', tasks: [{ id: 't1', occurrence_id: 'r1', title: 'Pack bag',
      occurrence_title: 'Morning', occurrence_kind: 'routine', description: null, is_reward: false, status: 'unlocked',
      assignee_ids: ['child'], lock_type: 'none', blocking_task_title: null, unlock_at: null, expires_at: null }] }
}
function change(id = 'op-1', completed = true, deviceTimeMs = 1_000) {
  return { id, accountId: 'parent', householdId: 'h1', deviceId: 'device-1', taskId: 't1', occurrenceId: 'r1', memberId: 'child', completed, deviceTimeMs }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-mobile-test-'))
  const filename = path.join(dir, 'device.db')
  let adapter = new SqliteAdapter(filename)
  let store = new LocalStore(adapter)
  await store.initialize()
  await store.cacheBoard('parent', snapshot())
  t.after(() => {
    adapter.close()
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { get store() { return store }, get adapter() { return adapter }, reopen: async () => {
    adapter.close(); adapter = new SqliteAdapter(filename); store = new LocalStore(adapter); await store.initialize(); return store
  } }
}

test('O01 O02 committed offline changes and sequence survive closing/reopening the database', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  const store = await f.reopen()
  assert.equal((await store.getBoard('parent', 'h1')).tasks[0].status, 'completed')
  assert.equal((await store.pending('parent'))[0].id, 'op-1')
  assert.equal((await store.enqueueCompletion(change('op-2', false))).sequence, 2)
})

test('U01 native controller publishes a task tap before its durable write completes', async t => {
  const f = await fixture(t)
  const realEnqueue = f.store.enqueueCompletion.bind(f.store)
  let release
  f.store.enqueueCompletion = async input => { await new Promise(resolve => { release = resolve }); return realEnqueue(input) }
  const controller = new BoardController(f.store, 'parent', 'device-1', {}, () => 'op-immediate')
  t.after(() => controller.stop())
  await controller.start()
  const save = controller.setCompleted(snapshot().tasks[0], 'child', true)
  assert.equal(controller.getSnapshot().board.tasks[0].status, 'completed')
  assert.equal((await f.store.pending('parent')).length, 0, 'screen response does not wait for disk')
  release()
  await save
  assert.equal((await f.store.pending('parent')).length, 1)
})

test('O04 native controller restores the prior task and exposes a failed local write', async t => {
  const f = await fixture(t)
  const controller = new BoardController(f.store, 'parent', 'device-1', {}, () => 'op-failed')
  t.after(() => controller.stop())
  await controller.start()
  f.adapter.failOnBoardWrite = true
  await controller.setCompleted(snapshot().tasks[0], 'child', true)
  assert.equal(controller.getSnapshot().board.tasks[0].status, 'unlocked')
  assert.match(controller.getSnapshot().error, /could not be saved on this device/)
  assert.equal(controller.getSnapshot().pending.length, 0)
})

test('O06 a server refresh started before a tap cannot replace the newer local result', async t => {
  const f = await fixture(t)
  let finishRefresh
  const api = {
    bootstrap: () => new Promise(resolve => { finishRefresh = resolve }),
    serverTime: async () => { throw new Error('Offline') },
  }
  const controller = new BoardController(f.store, 'parent', 'device-1', api, () => 'op-stale-refresh')
  t.after(() => controller.stop())
  await controller.start()
  controller.setConnectivity(true)
  await controller.setCompleted(snapshot().tasks[0], 'child', true)
  await f.store.correctBatch('parent', ['op-stale-refresh'], 0)
  await f.store.acknowledge('parent', { operationId: 'op-stale-refresh', outcome: 'applied', occurrenceTaskStatuses: [{ task_id: 't1', status: 'completed' }] })
  controller.setConnectivity(false)
  finishRefresh({ accountId: 'parent', households: [snapshot().household], board: snapshot() })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await f.store.getBoard('parent', 'h1')).tasks[0].status, 'completed')
  assert.equal(controller.getSnapshot().board.tasks[0].status, 'completed')
})

test('O07 retry scheduling ignores tasks blocked by rejection and sleeps until backoff expires', () => {
  const first = { ...change(), sequence: 1, state: 'rejected', nextAttemptMs: 0 }
  const second = { ...first, id: 'op2', sequence: 2, state: 'pending' }
  assert.equal(nextSyncDelay([], 100), null)
  assert.equal(nextSyncDelay([first, second], 100), null)
  assert.equal(nextSyncDelay([first, second, { ...second, taskId: 'other', nextAttemptMs: 500 }], 100), 400)
})

test('O03 O04 failed local commit rolls back both optimistic cache and outbox', async t => {
  const f = await fixture(t)
  f.adapter.failOnBoardWrite = true
  await assert.rejects(f.store.enqueueCompletion(change()), /disk write failure/)
  f.adapter.failOnBoardWrite = false
  const store = await f.reopen()
  assert.equal((await store.pending('parent')).length, 0)
  assert.equal((await store.getBoard('parent', 'h1')).tasks[0].status, 'unlocked')
})

test('O06 older acknowledgement and stale refresh cannot erase a newer local edit', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change('op-1', true))
  await f.store.enqueueCompletion(change('op-2', false))
  await f.store.cacheBoard('parent', { ...snapshot(), tasks: [{ ...snapshot().tasks[0], status: 'completed' }] })
  await f.store.acknowledge('parent', { operationId: 'op-1', outcome: 'applied', occurrenceTaskStatuses: [{ task_id: 't1', status: 'completed' }] })
  assert.equal((await f.store.getBoard('parent', 'h1')).tasks[0].status, 'unlocked')
  assert.deepEqual((await f.store.pending('parent')).map(c => c.id), ['op-2'])
})

test('O08 account boundaries prevent reading, sending or acknowledging another account queue', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  assert.equal(await f.store.getBoard('other', 'h1'), null)
  assert.deepEqual(await f.store.pending('other'), [])
  await f.store.acknowledge('other', { operationId: 'op-1', outcome: 'applied', occurrenceTaskStatuses: [] })
  assert.equal((await f.store.pending('parent')).length, 1)
})

test('C04 empty queue performs no time request; one sample serves a batch', async t => {
  const f = await fixture(t)
  let checks = 0, sends = 0
  const engine = new SyncEngine(f.store, 'parent', { serverTime: async () => { checks++; return 10_000 }, send: async c => {
    sends++; assert.equal(c.correctedTimeMs, c.deviceTimeMs + 9_000)
    return { operationId: c.id, outcome: 'applied', occurrenceTaskStatuses: [{ task_id: 't1', status: c.completed ? 'completed' : 'unlocked' }] }
  } }, () => {}, () => 1_000)
  await engine.flush()
  assert.equal(checks, 0)
  await f.store.enqueueCompletion(change('op-1', true))
  await f.store.enqueueCompletion(change('op-2', false, 1_001))
  await Promise.all([engine.flush(), engine.flush()])
  assert.equal(checks, 1); assert.equal(sends, 2)
  assert.equal((await f.store.pending('parent')).length, 0)
})

test('O05 lost acknowledgement retries the same ID and frozen correction after restart', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  const receipts = new Map()
  let checks = 0, effects = 0, first = true
  const transport = { serverTime: async () => { checks++; return 10_000 }, send: async c => {
    if (!receipts.has(c.id)) { effects++; receipts.set(c.id, { operationId: c.id, outcome: 'applied', occurrenceTaskStatuses: [{ task_id: c.taskId, status: 'completed' }] }) }
    if (first) { first = false; throw new Error('Acknowledgement lost') }
    assert.equal(c.correctedTimeMs, 10_000)
    return receipts.get(c.id)
  } }
  await new SyncEngine(f.store, 'parent', transport, () => {}, () => 1_000).flush()
  const store = await f.reopen()
  await new SyncEngine(store, 'parent', transport, () => {}, () => 5_000).flush()
  assert.equal(checks, 1); assert.equal(effects, 1); assert.equal((await store.pending('parent')).length, 0)
})

test('O07 permanent rejection remains visible and never retries in a busy loop', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  let sends = 0
  const engine = new SyncEngine(f.store, 'parent', { serverTime: async () => 1_000,
    send: async () => { sends++; throw new TransportError('Task was removed', 404) } }, () => {}, () => 1_000)
  await engine.flush(); await engine.flush()
  const pending = await f.store.pending('parent')
  assert.equal(sends, 1); assert.equal(pending[0].state, 'rejected'); assert.match(pending[0].error, /removed/)
})

test('O05 interruption during acknowledgement cleanup keeps operation recoverable', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  f.adapter.failOnBoardWrite = true
  await assert.rejects(f.store.acknowledge('parent', { operationId: 'op-1', outcome: 'applied', occurrenceTaskStatuses: [] }))
  f.adapter.failOnBoardWrite = false
  assert.equal((await (await f.reopen()).pending('parent')).length, 1)
})

test('O08 account switch during a network request retains the previous account operation', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  let engine
  engine = new SyncEngine(f.store, 'parent', { serverTime: async () => 1_000, send: async c => {
    engine.stop(); return { operationId: c.id, outcome: 'applied', occurrenceTaskStatuses: [] }
  } }, () => {}, () => 1_000)
  await engine.flush()
  assert.equal((await f.store.pending('parent')).length, 1)
})

test('A01 confirmed household removal clears private cache, retains rejected intent, and survives restart', async t => {
  const f = await fixture(t)
  await f.store.cacheBoard('another-account', snapshot())
  await f.store.enqueueCompletion(change())
  await f.store.reconcileHouseholds('parent', [])
  const store = await f.reopen()
  assert.equal(await store.getBoard('parent', 'h1'), null)
  assert.ok(await store.getBoard('another-account', 'h1'), 'account isolation')
  assert.equal((await store.pending('parent'))[0].state, 'rejected')
  await assert.rejects(store.retryRejected('parent', 'op-1'), /Access/)
  await assert.rejects(store.cacheBoard('parent', snapshot()), /Access/, 'late refresh cannot restore revoked data')
  await store.acknowledge('parent', { operationId: 'op-1', outcome: 'applied', occurrenceTaskStatuses: [] })
  assert.equal(await store.getBoard('parent', 'h1'), null, 'late acknowledgement cannot restore revoked data')
})

test('A02 rejected changes can be discarded without network only after confirmed loss of household access', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  await f.store.acknowledge('parent', { operationId: 'op-1', outcome: 'rejected', error: 'Task removed', occurrenceTaskStatuses: [] })
  await assert.rejects(f.store.discardRejected('parent', 'op-1', null), /matching household/)
  await assert.rejects(f.store.discardRejected('parent', 'op-1', { ...snapshot(), household: { ...snapshot().household, id: 'another-household' } }), /matching household/)
  assert.equal((await f.store.pending('parent')).length, 1)
  await f.store.reconcileHouseholds('parent', [])
  await f.store.discardRejected('parent', 'op-1', null)
  assert.equal((await f.store.pending('parent')).length, 0)
  assert.equal(await f.store.getBoard('parent', 'h1'), null)
})

test('A03 a removed selected household falls back to authenticated memberships without retaining its board', async t => {
  const f = await fixture(t)
  const next = { ...snapshot(), household: { ...snapshot().household, id: 'h2', name: 'Other family' }, tasks: [] }
  const requests = []
  const controller = new BoardController(f.store, 'parent', 'device-1', {
    bootstrap: async householdId => {
      requests.push(householdId)
      if (householdId === 'h1') throw new TransportError('Access removed', 403)
      return { accountId: 'parent', households: [next.household], board: next }
    },
  }, () => 'unused')
  t.after(() => controller.stop())
  await controller.start()
  const refreshed = new Promise(resolve => {
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().board?.household.id === 'h2') { unsubscribe(); resolve() }
    })
  })
  controller.setConnectivity(true)
  await refreshed
  assert.deepEqual(requests, ['h1', undefined])
  assert.equal(await f.store.getBoard('parent', 'h1'), null)
})

test('A04 membership refresh updates roles without losing task edits, and explicitly restored access can cache again', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  await f.store.reconcileHouseholds('parent', [{ ...snapshot().household, role: 'member' }])
  assert.equal((await f.store.getBoard('parent', 'h1')).household.role, 'member')
  assert.equal((await f.store.getBoard('parent', 'h1')).tasks[0].status, 'completed')
  await f.store.reconcileHouseholds('parent', [])
  await f.store.reconcileHouseholds('parent', [snapshot().household])
  await f.store.cacheBoard('parent', snapshot())
  assert.ok(await f.store.getBoard('parent', 'h1'))
  assert.equal((await f.store.pending('parent'))[0].state, 'rejected', 'restored access requires explicit retry')
  await f.store.retryRejected('parent', 'op-1')
  assert.equal((await f.store.pending('parent'))[0].state, 'pending')
})

test('C01 C02 clock offsets handle fast/slow clocks and reject a jump during measurement', () => {
  assert.equal(estimateClockOffset(10_000, 69_900, 70_100).offsetMs, -60_000)
  assert.equal(estimateClockOffset(70_000, 9_900, 10_100).offsetMs, 60_000)
  assert.throws(() => estimateClockOffset(1_000, 2_000, 1_000), /Clock changed/)
})

test('C03 conflict policy is deterministic and preserves same-device order across clock edits', () => {
  const base = { operationId: 'a', deviceId: 'one', sequence: 1, correctedTimeMs: 10_000 }
  assert.equal(compareCompletionVersions({ ...base, operationId: 'b', sequence: 2, correctedTimeMs: 5_000 }, base), 1)
  assert.equal(compareCompletionVersions({ ...base, operationId: 'b', deviceId: 'two' }, base), 1)
  assert.equal(compareCompletionVersions({ ...base, operationId: 'c', deviceId: 'two', correctedTimeMs: 9_000 }, base), -1)
  assert.equal(compareCompletionVersions(base, base), 0)
})

test('N06 N07 N08 N09 amended categories are distinct and independently selectable per device', () => {
  for (const key of ['routine_generated', 'routine_completed', 'routine_superseded', 'member_joined', 'member_added']) assert.ok(notificationCatalog[key])
  const phone = defaultNotificationPreferences('parent', 'Australia/Sydney')
  const tablet = defaultNotificationPreferences('parent', 'Australia/Sydney', true)
  phone.categories.task_completed = { enabled: true, memberIds: ['daughter'] }
  const request = { kind: 'task_completed', memberIds: ['daughter'], userId: 'parent', role: 'manager', now: new Date('2026-11-03T01:00:00Z') }
  assert.equal(shouldPushNotification({ ...request, preferences: phone }), true)
  assert.equal(shouldPushNotification({ ...request, preferences: tablet }), false)
  assert.equal(shouldPushNotification({ ...request, preferences: phone, memberIds: ['son'] }), false)
  assert.equal(shouldPushNotification({ ...request, preferences: phone, role: 'member' }), false)
  phone.categories.member_added = { enabled: true, memberIds: [] }
  assert.equal(shouldPushNotification({ ...request, preferences: phone, kind: 'member_joined' }), false)
  assert.equal(shouldPushNotification({ ...request, preferences: phone, kind: 'member_added' }), true)
})

test('N04 quiet hours cross midnight in the receiving device timezone', () => {
  const preferences = { ...defaultNotificationPreferences('parent', 'Australia/Sydney'), quietHours: { start: '22:00', end: '07:00' } }
  assert.equal(inQuietHours(preferences, new Date('2026-11-03T12:30:00Z')), true)
  assert.equal(inQuietHours(preferences, new Date('2026-11-03T20:00:00Z')), false)
})
