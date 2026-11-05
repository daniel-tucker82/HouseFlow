/* eslint-disable @typescript-eslint/no-require-imports -- Runs the mobile storage layer against real SQLite in Node. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { SqliteAdapter } = require('./helpers/mobile-sqlite.cjs')
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
const { LocalStore, SyncEngine, TransportError, BoardController, RunsController, nextSyncDelay, estimateClockOffset, compareCompletionVersions, readBoardHints,
  notificationCatalog, defaultNotificationPreferences, shouldPushNotification, inQuietHours } = load([
  'mobile/src/storage/local-store.ts', 'mobile/src/storage/sync-engine.ts', 'mobile/src/services/board-controller.ts',
  'shared/mobile/sync-policy.ts', 'shared/mobile/notification-catalog.ts',
  'mobile/src/services/runs-controller.ts',
  'mobile/src/services/board-live.ts',
])

test('board hints survive split/coalesced HTTP chunks and reject malformed or truncated handshakes', async () => {
  const receive = async (chunks, hint) => readBoardHints(new ReadableStream({ start(stream) {
    for (const chunk of chunks) stream.enqueue(new TextEncoder().encode(chunk))
    stream.close()
  } }), new AbortController().signal, hint)
  let hints = 0
  await receive(['re', 'ady\nch', 'anged\nchanged\n'], () => hints++)
  assert.equal(hints, 3)
  for (const malformed of ['changed\n', 'ready', 'household-secret', 'ready\nready\n', 'ready\ncha']) {
    await assert.rejects(receive([malformed], () => {}), /board signal/i)
  }
})

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

test('O09 delayed acknowledgement reveals newer server state after removing the optimistic edit, including after restart', async t => {
  const f = await fixture(t)
  const newer = snapshot()
  newer.tasks = [{ ...newer.tasks[0], status: 'unlocked', status_version: '9007199254740993' },
    { ...newer.tasks[0], id: 't2', status: 'completed', status_version: '9007199254740995' }]
  await f.store.enqueueCompletion(change())
  await f.store.cacheBoard('parent', newer)
  assert.equal((await f.store.getBoard('parent', 'h1')).tasks[0].status, 'completed', 'pending user intent remains visible')
  const store = await f.reopen()
  await store.acknowledge('parent', { operationId: 'op-1', outcome: 'applied', occurrenceTaskStatuses: [
    { task_id: 't1', status: 'completed', status_version: '9007199254740992' },
    { task_id: 't2', status: 'unlocked', status_version: '9007199254740994' },
  ] })
  assert.deepEqual((await store.getBoard('parent', 'h1')).tasks.map(task => task.status), ['unlocked', 'completed'])
  assert.equal((await store.pending('parent')).length, 0)
  assert.equal((await (await f.reopen()).getBoard('parent', 'h1')).tasks[0].status, 'unlocked')
})

test('O10 older server refresh and unversioned receipt cannot roll back acknowledged status', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  await f.store.acknowledge('parent', { operationId: 'op-1', outcome: 'applied', occurrenceTaskStatuses: [
    { task_id: 't1', status: 'completed', status_version: '20' },
  ] })
  const stale = snapshot()
  stale.tasks[0].status_version = '19'
  await f.store.cacheBoard('parent', stale)
  assert.equal((await f.store.getBoard('parent', 'h1')).tasks[0].status, 'completed')
  await f.store.enqueueCompletion(change('op-2', false))
  await f.store.acknowledge('parent', { operationId: 'op-2', outcome: 'superseded', occurrenceTaskStatuses: [
    { task_id: 't1', status: 'unlocked' },
  ] })
  assert.equal((await f.store.getBoard('parent', 'h1')).tasks[0].status, 'completed', 'clears the optimistic change to the canonical base')
})

test('O11 acknowledgements do not resurrect tasks removed by a refreshed board', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  await f.store.cacheBoard('parent', { ...snapshot(), tasks: [] })
  await f.store.acknowledge('parent', { operationId: 'op-1', outcome: 'applied', occurrenceTaskStatuses: [
    { task_id: 't1', status: 'completed', status_version: '20' },
  ] })
  assert.deepEqual((await f.store.getBoard('parent', 'h1')).tasks, [])
  assert.equal((await f.store.pending('parent')).length, 0)
})

test('O12 old cache format upgrades without losing offline intent or account scope', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  const legacy = await f.store.getBoard('parent', 'h1')
  await f.adapter.runAsync('UPDATE board_snapshots SET data = ? WHERE account_id = ?', JSON.stringify(legacy), 'parent')
  await f.adapter.execAsync('PRAGMA user_version = 2')
  const store = await f.reopen()
  assert.equal((await store.getBoard('parent', 'h1')).tasks[0].status, 'completed')
  assert.equal((await store.pending('parent')).length, 1)
  const authoritative = snapshot()
  authoritative.tasks[0].status_version = '50'
  await store.cacheBoard('parent', authoritative)
  await store.acknowledge('parent', { operationId: 'op-1', outcome: 'superseded', occurrenceTaskStatuses: [
    { task_id: 't1', status: 'unlocked', status_version: '50' },
  ] })
  assert.equal((await store.getBoard('parent', 'h1')).tasks[0].status, 'unlocked')
  assert.equal(await store.getBoard('other', 'h1'), null)
})

test('O13 discarding a rejected edit preserves newer canonical status learned during the refresh', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  await f.store.acknowledge('parent', { operationId: 'op-1', outcome: 'rejected', occurrenceTaskStatuses: [] })
  const latest = snapshot()
  latest.tasks[0] = { ...latest.tasks[0], status: 'locked', status_version: '8', lock_type: 'prerequisite', blocking_task_title: 'New prerequisite' }
  await f.store.cacheBoard('parent', latest)
  await f.store.discardRejected('parent', 'op-1', snapshot())
  const task = (await f.store.getBoard('parent', 'h1')).tasks[0]
  assert.equal(task.status, 'locked')
  assert.equal(task.blocking_task_title, 'New prerequisite')
})

test('O14 a completed upload batch refreshes routine visibility without another clock sample', { timeout: 2000 }, async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change())
  let reads = 0, clocks = 0, uploaded = false
  const controller = new BoardController(f.store, 'parent', 'device-1', {
    bootstrap: async () => {
      reads++
      return { accountId: 'parent', households: [snapshot().household], board: { ...snapshot(), tasks: uploaded ? [] : snapshot().tasks } }
    },
    serverTime: async () => { clocks++; return Date.now() },
    send: async edit => {
      uploaded = true
      return { operationId: edit.id, outcome: 'applied', occurrenceTaskStatuses: [{ task_id: 't1', status: 'completed', status_version: '2' }] }
    },
  }, () => 'unused')
  t.after(() => controller.stop())
  await controller.start()
  const completed = new Promise(resolve => {
    const unsubscribe = controller.subscribe(() => {
      const state = controller.getSnapshot()
      if (uploaded && !state.pending.length && state.board?.tasks.length === 0) { unsubscribe(); resolve() }
    })
  })
  controller.setConnectivity(true)
  await completed
  assert.equal(reads, 2, 'one reconnect read and one read after the changed batch')
  assert.equal(clocks, 1, 'no ongoing clock polling')
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

test('O07 a plan-limit rejection survives restart and waits for an explicit retry', async t => {
  const f = await fixture(t)
  await f.store.enqueueCompletion(change('plan-limit', false))
  let sends = 0, allowed = false, clockSamples = 0
  const transport = { serverTime: async () => { clockSamples++; return 1000 }, send: async c => {
    sends++
    if (!allowed) throw new TransportError('Finish an active run before reopening this one.', 402)
    return { operationId: c.id, outcome: 'applied', occurrenceTaskStatuses: [{ task_id: c.taskId, status: 'unlocked' }] }
  } }
  await new SyncEngine(f.store, 'parent', transport, () => {}, () => 1000).flush()
  const store = await f.reopen()
  const pending = await store.pending('parent')
  assert.equal(pending[0].state, 'rejected')
  assert.match(pending[0].error, /Finish an active run/)
  assert.equal(nextSyncDelay(pending, 2000), null)
  const resumed = new SyncEngine(store, 'parent', transport, () => {}, () => 2000)
  await resumed.flush(); assert.equal(sends, 1, 'no automatic retry while parent action is needed')
  allowed = true
  await store.retryRejected('parent', 'plan-limit')
  await resumed.flush()
  assert.equal(sends, 2); assert.equal(clockSamples, 1, 'retry preserves the original correction')
  assert.deepEqual(await store.pending('parent'), [])
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

function historicalRun(status = 'completed', version = '10') {
  const base = snapshot()
  return { ...base, tasks: [{ ...base.tasks[0], occurrence_id: 'old-run', status, status_version: version }],
    run: { id: 'old-run', routine_id: 'template', title: 'Yesterday morning', kind: 'routine', scheduled_for: '2026-11-02T00:00:00.000000Z', status,
      total_tasks: 1, completed_tasks: status === 'completed' ? 1 : 0 } }
}
const historyPage = (view, items = []) => ({ householdId: 'h1', view, items, nextCursor: null, fetchedAt: '2026-11-03T00:00:00Z' })

async function manageableRun(t) {
  const f = await fixture(t), run = { ...snapshot(), run: { ...historicalRun('active').run, id: 'r1', title: 'Morning' } }
  await f.store.cacheRunPage('parent', historyPage('active', [run.run]))
  await f.store.cacheRunPage('parent', historyPage('past'))
  await f.store.cacheRun('parent', run)
  return { ...f, store: f.store, run, reopen: f.reopen }
}

test('R09 confirmed renames update Today and run history atomically, preserving queued tasks and other accounts', async t => {
  const f = await manageableRun(t)
  await f.store.cacheRun('another-parent', f.run)
  await f.store.enqueueCompletion(change())
  f.adapter.failOnBoardWrite = true
  await assert.rejects(f.store.renameRun('parent', 'h1', 'r1', 'School morning'), /disk write/)
  assert.equal((await f.store.getRun('parent', 'h1', 'r1')).run.title, 'Morning')
  f.adapter.failOnBoardWrite = false
  await f.store.renameRun('parent', 'h1', 'r1', 'School morning')
  const store = await f.reopen()
  const renamed = await store.getRun('parent', 'h1', 'r1')
  assert.equal(renamed.run.title, 'School morning'); assert.equal(renamed.tasks[0].occurrence_title, 'School morning')
  assert.equal(renamed.tasks[0].status, 'completed'); assert.equal((await store.pending('parent')).length, 1)
  assert.equal((await store.getRunPage('parent', 'h1', 'past')).items[0].title, 'School morning')
  assert.equal((await store.getBoard('parent', 'h1')).tasks[0].occurrence_title, 'School morning')
  assert.equal((await store.getRun('another-parent', 'h1', 'r1')).run.title, 'Morning')
})

test('R10 confirmed deletion clears all matching views and retains unsent intent for review across restart', async t => {
  const f = await manageableRun(t)
  await f.store.cacheRun('parent', historicalRun())
  await f.store.cacheRun('another-parent', f.run)
  await f.store.enqueueCompletion(change())
  await f.store.enqueueCompletion({ ...change('other-run', false), occurrenceId: 'old-run' })
  f.adapter.failOnBoardWrite = true
  await assert.rejects(f.store.removeRun('parent', 'h1', 'r1'), /disk write/)
  assert.ok(await f.store.getRun('parent', 'h1', 'r1')); assert.equal((await f.store.pending('parent'))[0].state, 'pending')
  f.adapter.failOnBoardWrite = false
  await f.store.removeRun('parent', 'h1', 'r1')
  const store = await f.reopen()
  assert.equal(await store.getRun('parent', 'h1', 'r1'), null)
  assert.equal((await store.getBoard('parent', 'h1')).tasks.length, 0)
  assert.equal((await store.getRunPage('parent', 'h1', 'active')).items.some(run => run.id === 'r1'), false)
  assert.equal((await store.getRunPage('parent', 'h1', 'past')).items.some(run => run.id === 'r1'), false)
  assert.equal((await store.pending('parent')).find(row => row.id === 'op-1').state, 'rejected')
  assert.equal((await store.pending('parent')).find(row => row.id === 'other-run').state, 'pending')
  assert.ok(await store.getRun('parent', 'h1', 'old-run')); assert.ok(await store.getRun('another-parent', 'h1', 'r1'))
})

test('R11 native run changes fence late Today/history reads and reject repeat clicks', async t => {
  const f = await manageableRun(t), requests = [], calls = []
  const board = new BoardController(f.store, 'parent', 'device', { bootstrap: () => new Promise(resolve => requests.push({ type: 'board', resolve })) }, () => 'unused')
  let completeRename
  const runs = new RunsController(f.store, 'parent', {
    runs: () => new Promise(resolve => requests.push({ type: 'page', resolve })),
    run: () => new Promise(resolve => requests.push({ type: 'run', resolve })),
    renameRun: async (...args) => { calls.push(args); return new Promise(resolve => { completeRename = resolve }) },
    deleteRun: async () => { calls.push('delete') },
  }, board)
  const unsubscribe = board.subscribe(() => runs.observe(board.getSnapshot()))
  t.after(() => { unsubscribe(); runs.stop(); board.stop() })
  await board.start(); runs.setVisible(true); await runs.openRun('r1')
  board.setConnectivity(true); await new Promise(resolve => setImmediate(resolve))
  const rename = runs.renameRun('r1', '  School morning  ')
  assert.equal(runs.getSnapshot().managing, 'rename')
  await assert.rejects(runs.deleteRun('r1'), /Wait for/)
  completeRename('School morning'); assert.equal(await rename, true)
  const settleOld = () => { for (const request of requests.splice(0)) request.resolve(request.type === 'board' ? { accountId: 'parent', households: [snapshot().household], board: snapshot() } : request.type === 'page' ? historyPage('active', [f.run.run]) : f.run) }
  settleOld(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(runs.getSnapshot().run.run.title, 'School morning')
  assert.equal(board.getSnapshot().board.tasks[0].occurrence_title, 'School morning')
  assert.deepEqual(calls, [['h1', 'r1', 'School morning']])
  assert.equal(await runs.deleteRun('r1'), true)
  assert.equal(runs.getSnapshot().runId, null); assert.equal(board.getSnapshot().board.tasks.length, 0)
  settleOld()
})

test('R13 a page requested before creation cannot erase the acknowledged board', async t => {
  const f = await manageableRun(t), requests = []
  const board = new BoardController(f.store, 'parent', 'device', {}, () => 'unused')
  const runs = new RunsController(f.store, 'parent', { runs: () => new Promise(resolve => requests.push(resolve)) }, board)
  t.after(() => { runs.stop(); board.stop() })
  await board.start(); runs.observe({ ...board.getSnapshot(), online: true }); runs.setVisible(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 1)
  runs.invalidateCreationReads()
  const created = { ...f.run.run, id: 'new-board', title: 'Saturday jobs' }
  await f.store.cacheRunPage('parent', historyPage('active', [created, f.run.run]))
  requests.shift()(historyPage('active', [f.run.run]))
  await new Promise(resolve => setImmediate(resolve))
  runs.observe({ ...board.getSnapshot(), online: false })
  await runs.reloadAfterCreation()
  assert.equal(runs.getSnapshot().page.items[0].id, 'new-board')
  assert.equal((await f.store.getRunPage('parent', 'h1', 'active')).items.length, 2)
})

test('R12 run management requires current parent access and preserves data after an uncertain reply', async t => {
  const f = await manageableRun(t), board = new BoardController(f.store, 'parent', 'device', {}, () => 'unused')
  let allowed = true, calls = 0, finish
  const runs = new RunsController(f.store, 'parent', {
    renameRun: async () => { calls++; throw new Error('Connection interrupted; check status') },
    deleteRun: async () => { calls++; await new Promise(resolve => { finish = resolve }) },
  }, board, () => allowed)
  t.after(() => { runs.stop(); board.stop() })
  await board.start(); runs.observe(board.getSnapshot()); runs.setVisible(true); await runs.openRun('r1')
  await assert.rejects(runs.deleteRun('r1'), /Connect/); assert.equal(calls, 0)
  runs.observe({ ...board.getSnapshot(), online: true }); allowed = false
  await assert.rejects(runs.deleteRun('r1'), /parent access/); allowed = true
  runs.observe({ ...board.getSnapshot(), online: true, board: { ...snapshot(), household: { ...snapshot().household, role: 'member' } } })
  await assert.rejects(runs.deleteRun('r1'), /parent access/); assert.equal(calls, 0)
  runs.observe({ ...board.getSnapshot(), online: true })
  await assert.rejects(runs.renameRun('r1', '  '), /Enter a name/)
  await assert.rejects(runs.renameRun('r1', 'New name'), /Connection interrupted/)
  assert.equal((await f.store.getRun('parent', 'h1', 'r1')).run.title, 'Morning')
  const deletion = runs.deleteRun('r1'); allowed = false; finish()
  assert.equal(await deletion, false); assert.ok(await f.store.getRun('parent', 'h1', 'r1'))
  assert.equal(calls, 2)
})

test('R01 reopening a saved historical task is atomic, survives restart, and updates both run lists', async t => {
  const f = await fixture(t), historical = historicalRun()
  await f.store.cacheRunPage('parent', historyPage('past', [historical.run]))
  await f.store.cacheRunPage('parent', historyPage('active'))
  await f.store.cacheRun('parent', historical)
  f.adapter.failOnBoardWrite = true
  await assert.rejects(f.store.enqueueCompletion({ ...change('reopen', false), occurrenceId: 'old-run' }), /disk write/)
  assert.equal((await f.store.pending('parent')).length, 0)
  assert.equal((await f.store.getRun('parent', 'h1', 'old-run')).tasks[0].status, 'completed')
  f.adapter.failOnBoardWrite = false
  await f.store.enqueueCompletion({ ...change('reopen', false), occurrenceId: 'old-run' })
  const store = await f.reopen()
  assert.equal((await store.getRun('parent', 'h1', 'old-run')).run.status, 'active')
  assert.equal((await store.getRunPage('parent', 'h1', 'past')).items.length, 0)
  assert.equal((await store.getRunPage('parent', 'h1', 'active')).items[0].id, 'old-run')
  assert.equal(await store.getRun('other-account', 'h1', 'old-run'), null)
  await store.acknowledge('parent', { operationId: 'reopen', outcome: 'applied', occurrenceTaskStatuses: [{ task_id: 't1', status: 'unlocked', status_version: '11' }] })
  await store.cacheRun('parent', historical)
  assert.equal((await store.getRun('parent', 'h1', 'old-run')).tasks[0].status, 'unlocked', 'an older read cannot undo an acknowledgement')
  assert.equal((await store.getBoard('parent', 'h1')).tasks[0].status, 'unlocked', 'another occurrence using the same task ID is unchanged')
})

test('R02 history refresh retains unsynced intent; revocation clears history and prevents further edits', async t => {
  const f = await fixture(t), historical = historicalRun()
  await f.store.cacheRun('parent', historical)
  await f.store.enqueueCompletion({ ...change('reopen', false), occurrenceId: 'old-run' })
  await f.store.cacheRunPage('parent', historyPage('past', [historical.run]))
  assert.equal((await f.store.getRunPage('parent', 'h1', 'past')).items.length, 0)
  await f.store.cacheRunPage('parent', historyPage('active'))
  assert.equal((await f.store.getRunPage('parent', 'h1', 'active')).items[0].id, 'old-run')
  await f.store.reconcileHouseholds('parent', [])
  assert.equal(await f.store.getRun('parent', 'h1', 'old-run'), null)
  assert.equal(await f.store.getRunPage('parent', 'h1', 'past'), null)
  assert.equal((await f.store.pending('parent'))[0].state, 'rejected')
  await assert.rejects(f.store.cacheRun('parent', historical), /removed/)
  await assert.rejects(f.store.enqueueCompletion({ ...change('another', false), occurrenceId: 'old-run' }), /not available/)
})

test('R03 paging deduplicates runs and denied/cancelled historical edits never enter the outbox', async t => {
  const f = await fixture(t), historical = historicalRun()
  await f.store.cacheRunPage('parent', { ...historyPage('past', [historical.run]), nextCursor: 'page2' })
  await f.store.cacheRunPage('parent', historyPage('past', [historical.run, { ...historical.run, id: 'older' }]), true)
  assert.deepEqual((await f.store.getRunPage('parent', 'h1', 'past')).items.map(run => run.id), ['old-run', 'older'])
  await f.store.cacheRun('parent', { ...historical, run: { ...historical.run, status: 'cancelled' } })
  await assert.rejects(f.store.enqueueCompletion({ ...change('cancelled', false), occurrenceId: 'old-run' }), /cancelled/)
  await f.store.cacheRun('parent', { ...historical, household: { ...historical.household, role: 'member' } })
  await assert.rejects(f.store.enqueueCompletion({ ...change('denied', false), occurrenceId: 'old-run' }), /assigned to you/)
  assert.equal((await f.store.pending('parent')).length, 0)
})

test('R04 run controller publishes a tap before storage, and keeps offline details after navigation/restart', async t => {
  const f = await fixture(t), historical = historicalRun()
  await f.store.cacheRun('parent', historical)
  const board = new BoardController(f.store, 'parent', 'device-1', {}, () => 'history-tap')
  const runs = new RunsController(f.store, 'parent', {}, board)
  const subscription = board.subscribe(() => runs.observe(board.getSnapshot()))
  t.after(() => { subscription(); runs.stop(); board.stop() })
  await board.start(); runs.setVisible(true); await runs.openRun('old-run')
  let release; const enqueue = f.store.enqueueCompletion.bind(f.store)
  f.store.enqueueCompletion = async input => { await new Promise(resolve => { release = resolve }); return enqueue(input) }
  const save = runs.setCompleted(historical.tasks[0], 'child', false)
  assert.equal(runs.getSnapshot().run.tasks[0].status, 'unlocked')
  assert.equal((await f.store.pending('parent')).length, 0)
  release(); await save
  runs.closeRun(); await runs.openRun('old-run')
  assert.equal(runs.getSnapshot().run.tasks[0].status, 'unlocked')
  assert.equal(runs.getSnapshot().runError, null)
  await runs.openRun('not-cached')
  assert.match(runs.getSnapshot().runError, /Connect once/)
})

test('R05 old household/page/detail responses cannot replace the newly selected history', async t => {
  const f = await fixture(t), waits = []
  const board = new BoardController(f.store, 'parent', 'device', {}, () => 'unused')
  const runs = new RunsController(f.store, 'parent', {
    runs: async (householdId, view) => new Promise(resolve => waits.push({ householdId, view, resolve })),
    run: async () => new Promise(resolve => waits.push({ detail: true, resolve })),
  }, board)
  t.after(() => { runs.stop(); board.stop() })
  await board.start(); runs.observe({ ...board.getSnapshot(), online: true }); runs.setVisible(true)
  const open = runs.openRun('old-run'); await new Promise(resolve => setImmediate(resolve))
  const second = { ...snapshot().household, id: 'h2', name: 'Other household' }
  runs.observe({ ...board.getSnapshot(), board: { ...snapshot(), household: second }, online: true })
  for (const request of waits.filter(item => item.householdId === 'h1')) request.resolve(historyPage('active', [historicalRun().run]))
  for (const request of waits.filter(item => item.detail)) request.resolve(historicalRun())
  await open
  assert.equal(runs.getSnapshot().household.id, 'h2')
  assert.equal(runs.getSnapshot().run, null)
  assert.equal(await f.store.getRunPage('parent', 'h1', 'active'), null)
  for (const request of waits.filter(item => item.householdId === 'h2')) request.resolve({ ...historyPage('active'), householdId: 'h2' })
  await new Promise(resolve => setImmediate(resolve))
})

test('R06 an open run observes task and role changes learned by Today without navigation', async t => {
  const f = await fixture(t), historical = historicalRun()
  historical.tasks[0].status = 'unlocked'; historical.run.status = 'active'; historical.run.completed_tasks = 0
  await f.store.cacheRun('parent', historical)
  const board = new BoardController(f.store, 'parent', 'device', {}, () => 'unused')
  const runs = new RunsController(f.store, 'parent', {}, board)
  t.after(() => { runs.stop(); board.stop() })
  await board.start(); runs.observe(board.getSnapshot()); await runs.openRun('old-run')
  const next = { ...historical, fetchedAt: '2026-11-03T00:01:00Z', household: { ...historical.household, role: 'member' },
    tasks: [{ ...historical.tasks[0], status: 'completed', status_version: '11' }] }
  await f.store.cacheBoard('parent', next)
  const updated = new Promise(resolve => {
    const unsubscribe = runs.subscribe(() => {
      if (runs.getSnapshot().run?.tasks[0].status_version === '11') { unsubscribe(); resolve() }
    })
  })
  runs.observe({ ...board.getSnapshot(), board: await f.store.getBoard('parent', 'h1') })
  await updated
  assert.equal(runs.getSnapshot().run.run.status, 'completed')
  assert.equal(runs.getSnapshot().run.household.role, 'member')
})

test('R07 discarding a rejected historical edit atomically restores the freshly fetched run', async t => {
  const f = await fixture(t), historical = historicalRun()
  await f.store.cacheRun('parent', historical)
  await f.store.enqueueCompletion({ ...change('reopen', false), occurrenceId: 'old-run' })
  await f.store.acknowledge('parent', { operationId: 'reopen', outcome: 'rejected', error: 'Free active-run limit', occurrenceTaskStatuses: [] })
  await assert.rejects(f.store.discardRejected('parent', 'reopen', snapshot(), { ...historical, run: { ...historical.run, id: 'wrong-run' } }), /matching run/)
  assert.equal((await f.store.pending('parent')).length, 1)
  f.adapter.failOnBoardWrite = true
  await assert.rejects(f.store.discardRejected('parent', 'reopen', snapshot(), historicalRun('completed', '11')), /disk write/)
  f.adapter.failOnBoardWrite = false
  await f.store.discardRejected('parent', 'reopen', snapshot(), historicalRun('completed', '11'))
  assert.equal((await f.store.pending('parent')).length, 0)
  assert.equal((await f.store.getRun('parent', 'h1', 'old-run')).tasks[0].status_version, '11')
  assert.equal((await f.store.getRun('parent', 'h1', 'old-run')).run.status, 'completed')
})

test('R08 discarding a removed run cannot leave a stale list entry after interruption', async t => {
  const f = await fixture(t), historical = historicalRun()
  await f.store.cacheRunPage('parent', historyPage('active'))
  await f.store.cacheRunPage('parent', historyPage('past', [historical.run]))
  await f.store.cacheRun('parent', historical)
  await f.store.enqueueCompletion({ ...change('reopen', false), occurrenceId: 'old-run' })
  await f.store.acknowledge('parent', { operationId: 'reopen', outcome: 'rejected', error: 'Run removed', occurrenceTaskStatuses: [] })
  const original = f.adapter.runAsync.bind(f.adapter)
  f.adapter.runAsync = async (sql, ...values) => {
    if (sql.includes('UPDATE run_pages')) throw new Error('Interrupted list write')
    return original(sql, ...values)
  }
  await assert.rejects(f.store.discardRejected('parent', 'reopen', snapshot(), null), /Interrupted/)
  f.adapter.runAsync = original
  assert.equal((await f.store.pending('parent')).length, 1)
  assert.ok(await f.store.getRun('parent', 'h1', 'old-run'))
  assert.equal((await f.store.getRunPage('parent', 'h1', 'active')).items.length, 1)
  await f.store.discardRejected('parent', 'reopen', snapshot(), null)
  const store = await f.reopen()
  assert.equal((await store.pending('parent')).length, 0)
  assert.equal(await store.getRun('parent', 'h1', 'old-run'), null)
  assert.equal((await store.getRunPage('parent', 'h1', 'active')).items.length, 0)
  assert.equal((await store.getRunPage('parent', 'h1', 'past')).items.length, 0)
  await store.acknowledge('parent', { operationId: 'reopen', outcome: 'applied', occurrenceTaskStatuses: [{ task_id: 't1', status: 'unlocked', status_version: '12' }] })
  assert.equal(await store.getRun('parent', 'h1', 'old-run'), null, 'a late receipt cannot recreate a removed run')
})
