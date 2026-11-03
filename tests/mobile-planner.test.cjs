/* eslint-disable @typescript-eslint/no-require-imports -- Native planner services tested against real SQLite. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const entry = path.resolve(__dirname, 'planner-entry.cjs')
const sources = ['mobile/src/storage/local-store.ts', 'mobile/src/services/planner-controller.ts', 'mobile/src/storage/sync-engine.ts']
const bundle = buildSync({ stdin: { contents: sources.map(file => `export * from ${JSON.stringify(path.resolve(__dirname, '..', file))}`).join(';'), resolveDir: __dirname }, bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = new Module(entry)
loaded._compile(bundle.outputFiles[0].text, entry)
const { LocalStore, PlannerController, TransportError } = loaded.exports
const household = { id: 'h1', name: 'Family', role: 'manager', leaderId: 'parent', timezone: 'Australia/Sydney' }
function snapshot() {
  return { householdId: 'h1', routines: [{ id: 'r1', name: 'Morning', household_id: 'h1' }], members: [{ id: 'child', name: 'Alex' }],
    occurrences: [], dependencies: [], taskAssignees: [], tasks: [{ id: 't1', household_id: 'h1', routine_id: 'r1', title: 'Pack bag', description: null,
      is_reward: false, assignee_id: null, position_x: 80, position_y: 90, unlock_rule: { kind: 'after_generation_days', days: 1 } }] }
}
function draft(title = 'Pack lunch') { return { taskId: 't1', routineId: 'r1', isNew: false, title, notes: 'For tomorrow', isReward: false, assigneeIds: ['child'], prerequisiteIds: [] } }
class Adapter {
  constructor(filename) { this.db = new DatabaseSync(filename); this.tail = Promise.resolve(); this.fail = false }
  async execAsync(sql) { this.db.exec(sql) }
  async runAsync(sql, ...params) { if (this.fail && sql.includes('INSERT INTO planner_snapshots')) throw new Error('Disk full'); return this.db.prepare(sql).run(...params) }
  async getFirstAsync(sql, ...params) { return this.db.prepare(sql).get(...params) ?? null }
  async getAllAsync(sql, ...params) { return this.db.prepare(sql).all(...params) }
  withExclusiveTransactionAsync(work) {
    const result = this.tail.then(async () => { this.db.exec('BEGIN IMMEDIATE'); try { await work(this); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error } })
    this.tail = result.catch(() => {}); return result
  }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-planner-')), filename = path.join(dir, 'planner.db')
  let adapter = new Adapter(filename), local = new LocalStore(adapter)
  await local.initialize(); await local.reconcileHouseholds('parent', [household]); await local.planner.cache('parent', 'h1', snapshot())
  t.after(() => { adapter.db.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }) })
  return { get local() { return local }, get adapter() { return adapter }, reopen: async () => {
    adapter.db.close(); adapter = new Adapter(filename); local = new LocalStore(adapter); await local.initialize(); return local
  } }
}
function until(controller, predicate) {
  if (predicate(controller.getSnapshot())) return Promise.resolve()
  return new Promise(resolve => { const unsubscribe = controller.subscribe(() => { if (predicate(controller.getSnapshot())) { unsubscribe(); resolve() } }) })
}

test('P01 task edits and assignments survive restart, preserve time/canvas fields, and stay account scoped', async t => {
  const f = await fixture(t)
  await f.local.planner.enqueue('parent', 'h1', 'device', 'edit1', draft())
  const local = await f.reopen(), data = await local.planner.get('parent', 'h1')
  assert.equal(data.tasks[0].title, 'Pack lunch')
  assert.deepEqual(data.taskAssignees, [{ task_id: 't1', user_id: 'child' }])
  assert.deepEqual(data.tasks[0].unlock_rule, snapshot().tasks[0].unlock_rule)
  assert.equal(data.tasks[0].position_y, 90)
  assert.equal((await local.planner.pending('parent'))[0].id, 'edit1')
  assert.equal(await local.planner.get('other-account', 'h1'), null)
  assert.deepEqual(await local.planner.pending('other-account'), [])
})

test('P02 disk failure rolls back both planner cache and queued edit', async t => {
  const f = await fixture(t)
  f.adapter.fail = true
  await assert.rejects(f.local.planner.enqueue('parent', 'h1', 'device', 'edit1', draft()), /Disk full/)
  const local = await f.reopen()
  assert.equal((await local.planner.get('parent', 'h1')).tasks[0].title, 'Pack bag')
  assert.deepEqual(await local.planner.pending('parent'), [])
})

test('P15 offline timing survives restart, coalesced basic edits, old replies and explicit clearing', async t => {
  const f = await fixture(t)
  const timing = { unlockRule: { kind: 'weekday_after_generation', weekday: 1, nth: 2, time: '08:30' },
    expiryRule: { kind: 'after_unlock', amount: 2, unit: 'hours' }, unlockCombiner: 'or' }
  await f.local.planner.enqueue('parent', 'h1', 'device', 'timing1', { ...draft(), timing })
  const first = (await f.local.planner.pending('parent'))[0]
  await f.local.planner.enqueue('parent', 'h1', 'device', 'timing2', draft('Renamed offline'))
  await f.local.planner.acknowledge(first)
  const local = await f.reopen(), pending = (await local.planner.pending('parent'))[0]
  assert.deepEqual(pending.draft.timing, timing)
  const task = (await local.planner.get('parent', 'h1')).tasks[0]
  assert.equal(task.title, 'Renamed offline'); assert.deepEqual(task.unlock_rule, timing.unlockRule)
  assert.deepEqual(task.expiry_rule, timing.expiryRule); assert.equal(task.unlock_combiner, 'or')
  await local.planner.enqueue('parent', 'h1', 'device', 'clear', { ...draft(), timing: { unlockRule: null, expiryRule: null, unlockCombiner: 'and' } })
  assert.equal((await local.planner.get('parent', 'h1')).tasks[0].unlock_rule, null)
  await assert.rejects(local.planner.enqueue('parent', 'h1', 'device', 'invalid', { ...draft(), timing: { ...timing, unlockRule: { kind: 'fixed', date: '2026-02-30' } } }), /calendar date/)
  assert.equal((await local.planner.pending('parent'))[0].id, 'clear')
})

test('P03 replacing an in-flight edit retains the newest draft and revision after an older acknowledgement', async t => {
  const f = await fixture(t)
  await f.local.planner.enqueue('parent', 'h1', 'device', 'edit1', draft('First edit'))
  const first = (await f.local.planner.pending('parent'))[0]
  await f.local.planner.enqueue('parent', 'h1', 'device', 'edit2', draft('Latest edit'))
  await f.local.planner.acknowledge(first)
  const pending = await f.local.planner.pending('parent')
  assert.equal(pending.length, 1); assert.equal(pending[0].id, 'edit2'); assert.ok(pending[0].revision > first.revision)
  assert.equal((await f.local.planner.get('parent', 'h1')).tasks[0].title, 'Latest edit')
  await f.local.planner.fail(first, 'Old reply failed', true, Date.now())
  assert.equal((await f.local.planner.pending('parent'))[0].state, 'pending')
})

test('P04 role removal purges planner cache, rejects pending edits and blocks late reads/retries', async t => {
  const f = await fixture(t)
  await f.local.planner.enqueue('parent', 'h1', 'device', 'edit1', draft())
  await f.local.reconcileHouseholds('parent', [{ ...household, role: 'member' }])
  const local = await f.reopen(), edit = (await local.planner.pending('parent'))[0]
  assert.equal(await local.planner.get('parent', 'h1'), null); assert.equal(edit.state, 'rejected')
  await assert.rejects(local.planner.cache('parent', 'h1', snapshot()), /permission/)
  await assert.rejects(local.planner.retry('parent', edit), /permission/)
  await local.planner.discard('parent', edit, null)
  assert.deepEqual(await local.planner.pending('parent'), [])
})

test('P13 network failures arriving after access revocation cannot restart background retries', async t => {
  const f = await fixture(t)
  await f.local.planner.enqueue('parent', 'h1', 'device', 'edit1', draft())
  const edit = (await f.local.planner.pending('parent'))[0]
  await f.local.planner.enqueueCreation({ id: 'creation1', accountId: 'parent', householdId: 'h1', label: 'Routine: Morning', body: { action: 'createRoutine' } })
  const creation = (await f.local.planner.creations('parent'))[0]
  await f.local.reconcileHouseholds('parent', [])
  await f.local.planner.fail(edit, 'Network disconnected', false, Date.now())
  await f.local.planner.failCreation(creation, 'Network disconnected', false, Date.now())
  assert.equal((await f.local.planner.pending('parent'))[0].state, 'rejected')
  assert.equal((await f.local.planner.creations('parent'))[0].state, 'rejected')
})

test('P05 a controller displays a task edit immediately before its durable write finishes', async t => {
  const f = await fixture(t)
  const controller = new PlannerController(f.local.planner, 'parent', 'device', {}, () => 'immediate')
  t.after(() => controller.stop())
  await controller.selectHousehold(household)
  const enqueue = f.local.planner.enqueue.bind(f.local.planner)
  let release
  f.local.planner.enqueue = async (...args) => { await new Promise(resolve => { release = resolve }); return enqueue(...args) }
  const save = controller.saveTask(draft())
  assert.equal(controller.getSnapshot().data.tasks[0].title, 'Pack lunch')
  assert.deepEqual(await f.local.planner.pending('parent'), [])
  release(); await save
  assert.equal((await f.local.planner.pending('parent')).length, 1)
})

test('P06 deleted tasks stay deleted when an old queued edit is acknowledged', async t => {
  const f = await fixture(t)
  await f.local.planner.enqueue('parent', 'h1', 'device', 'edit1', draft())
  const edit = (await f.local.planner.pending('parent'))[0]
  await f.local.planner.cache('parent', 'h1', { ...snapshot(), tasks: [] })
  await f.local.planner.acknowledge(edit)
  assert.deepEqual((await f.local.planner.get('parent', 'h1')).tasks, [])
})

test('P07 lost response survives restart and retries the same operation version', { timeout: 4000 }, async t => {
  const f = await fixture(t)
  await f.local.planner.enqueue('parent', 'h1', 'device', 'edit1', draft())
  let first = true, effects = 0, version
  const api = { planner: async () => snapshot(), savePlannerEdit: async edit => {
    if (first) { first = false; effects++; version = { id: edit.id, revision: edit.revision, deviceId: edit.deviceId }; throw new Error('Reply lost') }
    assert.deepEqual({ id: edit.id, revision: edit.revision, deviceId: edit.deviceId }, version)
  } }
  let controller = new PlannerController(f.local.planner, 'parent', 'device', api, () => 'unused')
  await controller.selectHousehold(household); controller.setConnectivity(true)
  await until(controller, state => state.pending[0]?.attempts === 1)
  controller.stop()
  const local = await f.reopen(), edit = (await local.planner.pending('parent'))[0]
  // Make the persisted backoff due; the production controller uses the same timestamp after restart.
  await f.adapter.runAsync('UPDATE planner_edits SET next_attempt_ms=0 WHERE id=?', edit.id)
  controller = new PlannerController(local.planner, 'parent', 'device', api, () => 'unused')
  t.after(() => controller.stop())
  await controller.selectHousehold(household); controller.setConnectivity(true)
  await until(controller, state => state.pending.length === 0)
  assert.equal(effects, 1)
})

test('P08 starting a routine blocks on a retained task rejection without sending a start', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  await f.local.planner.enqueue('parent', 'h1', 'device', 'edit1', draft())
  let writes = 0
  const controller = new PlannerController(f.local.planner, 'parent', 'device', {
    planner: async () => snapshot(), savePlannerEdit: async () => { throw new TransportError('Task removed', 404) },
    request: async () => { writes++ },
  }, () => 'unused')
  t.after(() => controller.stop())
  await controller.selectHousehold(household); controller.setConnectivity(true)
  await until(controller, state => state.pending[0]?.state === 'rejected')
  await assert.rejects(controller.create('createOccurrence', { routineId: 'r1' }, 'Start Morning'), /Sync or review/)
  assert.equal(writes, 0); assert.equal(controller.getSnapshot().pending[0].state, 'rejected')
})

test('P09 discarded edits require the matching household snapshot', async t => {
  const f = await fixture(t)
  await f.local.planner.enqueue('parent', 'h1', 'device', 'edit1', draft())
  const edit = (await f.local.planner.pending('parent'))[0]
  await f.local.planner.fail(edit, 'Rejected', true, Date.now())
  await assert.rejects(f.local.planner.discard('parent', edit, { ...snapshot(), householdId: 'other' }), /Unexpected household/)
  await assert.rejects(f.local.planner.discard('parent', edit, null), /Connect/)
  assert.equal((await f.local.planner.pending('parent')).length, 1)
})

test('P10 an obsolete discard cannot overwrite a newer household snapshot', async t => {
  const f = await fixture(t)
  await f.local.planner.enqueue('parent', 'h1', 'device', 'old', draft('Rejected'))
  const old = (await f.local.planner.pending('parent'))[0]
  await f.local.planner.fail(old, 'Rejected', true, Date.now())
  const newer = snapshot(); newer.routines[0].name = 'Newer household name'
  await f.local.planner.cache('parent', 'h1', newer)
  await f.local.planner.enqueue('parent', 'h1', 'device', 'new', draft('Replacement'))
  await f.local.planner.discard('parent', old, snapshot())
  assert.equal((await f.local.planner.get('parent', 'h1')).routines[0].name, 'Newer household name')
  assert.equal((await f.local.planner.pending('parent'))[0].id, 'new')
})

test('P11 interrupted creation retains its immutable request after restart and clears its draft atomically', { timeout: 4000 }, async t => {
  const f = await fixture(t)
  await f.local.saveSetting('parent', 'planner-task-draft:h1', { ...draft(), isNew: true })
  let request
  let controller = new PlannerController(f.local.planner, 'parent', 'device', {
    planner: async () => snapshot(), request: async (_path, body) => { request = body; throw new Error('Reply lost') },
  }, () => 'creation1')
  await controller.selectHousehold(household)
  await controller.create('createTask', { ...draft(), isNew: true }, 'Task: Pack lunch')
  assert.equal(await f.local.setting('parent', 'planner-task-draft:h1'), null)
  controller.setConnectivity(true)
  await until(controller, state => state.creations[0]?.attempts === 1)
  controller.stop()
  const local = await f.reopen()
  const stored = (await local.planner.creations('parent'))[0]
  assert.deepEqual(stored.body, request)
  assert.deepEqual(await local.planner.creations('other-account'), [])
  await local.planner.discardCreation('parent', stored.id)
  assert.equal((await local.planner.creations('parent')).length, 1, 'an uncertain outcome cannot be silently discarded')
  await f.adapter.runAsync('UPDATE planner_creations SET next_attempt_ms=0')
  controller = new PlannerController(local.planner, 'parent', 'device', {
    planner: async () => snapshot(), request: async (_path, body) => { assert.deepEqual(body, request) },
  }, () => 'unused')
  t.after(() => controller.stop())
  await controller.selectHousehold(household); controller.setConnectivity(true)
  await until(controller, state => state.creations.length === 0)
})

test('P12 revoked management access retains creations for review and prevents retries', async t => {
  const f = await fixture(t)
  const controller = new PlannerController(f.local.planner, 'parent', 'device', {}, () => 'creation1')
  t.after(() => controller.stop())
  await controller.selectHousehold(household)
  await controller.create('createRoutine', { name: 'Morning' }, 'Routine: Morning')
  await f.local.reconcileHouseholds('parent', [])
  await controller.selectHousehold(null)
  const creation = controller.getSnapshot().creations[0]
  assert.equal(creation.state, 'rejected')
  await assert.rejects(controller.retryCreation(creation), /permission/)
  await controller.discardCreation(creation)
  assert.deepEqual(await f.local.planner.creations('parent'), [])
})

test('P14 starting a routine cannot overtake a task edit still being written to the device', { timeout: 4000 }, async t => {
  const f = await fixture(t), events = []
  const controller = new PlannerController(f.local.planner, 'parent', 'device', {
    planner: async () => snapshot(), savePlannerEdit: async () => { throw new TransportError('Review this edit', 409) },
    request: async () => { events.push('routine started') },
  }, () => 'edit1')
  t.after(() => controller.stop())
  await controller.selectHousehold(household); controller.setConnectivity(true)
  const enqueue = f.local.planner.enqueue.bind(f.local.planner)
  let release
  f.local.planner.enqueue = async (...args) => { await new Promise(resolve => { release = resolve }); await enqueue(...args) }
  const save = controller.saveTask(draft())
  const start = assert.rejects(controller.create('createOccurrence', { routineId: 'r1' }, 'Start Morning'), /Sync or review/)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, [])
  release(); await save; await start
  assert.deepEqual(events, [])
})

test('P16 a start saves locally before the server replies, survives restart and refreshes Today after acknowledgement', { timeout: 4000 }, async t => {
  const f = await fixture(t)
  let release, received, refreshed = 0
  let controller = new PlannerController(f.local.planner, 'parent', 'device', {
    planner: async () => snapshot(), request: async (_path, body) => {
      received = body
      await new Promise(resolve => { release = resolve })
      throw new Error('Reply lost after commit')
    },
  }, () => 'start1')
  await controller.selectHousehold(household); controller.setConnectivity(true)
  await controller.create('createOccurrence', { routineId: 'r1' }, 'Start Morning')
  assert.equal(controller.getSnapshot().busy, false)
  const queued = (await f.local.planner.creations('parent'))[0]
  assert.equal(queued.body.action, 'createOccurrence')
  assert.equal(queued.body.scheduledFor, undefined, 'server assigns the start time only on the first committed attempt')
  await assert.rejects(controller.create('createOccurrence', { routineId: 'r1' }, 'Start Morning again'), /Sync or review/)
  await assert.rejects(controller.saveTask(draft()), /saved start request/)
  await assert.rejects(controller.create('createTask', { ...draft(), isNew: true }, 'Task'), /saved start request/)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  release()
  await until(controller, state => state.creations[0]?.attempts === 1)
  controller.stop()
  const local = await f.reopen()
  await f.adapter.runAsync('UPDATE planner_creations SET next_attempt_ms=0')
  controller = new PlannerController(local.planner, 'parent', 'device', {
    planner: async () => snapshot(), request: async (_path, body) => assert.deepEqual(body, received),
  }, () => 'unused', async () => { refreshed++ })
  t.after(() => controller.stop())
  await controller.selectHousehold(household); controller.setConnectivity(true)
  await until(controller, state => state.creations.length === 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(refreshed, 1)
  await local.planner.enqueue('parent', 'h1', 'device', 'edit-after-start', draft())
})

test('P17 two simultaneous start submissions cannot pass the local transaction guard', async t => {
  const f = await fixture(t)
  const start = { accountId: 'parent', householdId: 'h1', label: 'Start Morning', body: { action: 'createOccurrence', routineId: 'r1' } }
  const results = await Promise.allSettled(['start-a', 'start-b'].map(id => f.local.planner.enqueueCreation({ ...start, id })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await f.local.planner.creations('parent')).length, 1)
  assert.deepEqual(await f.local.planner.creations('other'), [])
})

const emptySchedule = { rules: [], completeOlderOccurrencesOnNew: false }
const dailySchedule = { rules: [{ id: 'daily', frequency: 'daily', interval: 2, time: '09:00', startDate: '2026-11-04' }], completeOlderOccurrencesOnNew: true }
const scheduleRequest = id => ({ id, accountId: 'parent', householdId: 'h1', label: 'Schedule: Morning', body: {
  action: 'saveRoutineSchedule', routineId: 'r1', baseSchedule: emptySchedule, schedule: dailySchedule, creationId: id,
} })

test('P18 schedule and draft submission survive restart together, and acknowledgement keeps the saved view', async t => {
  const f = await fixture(t)
  await f.local.saveSetting('parent', 'planner-schedule-draft:h1', { schedule: dailySchedule })
  await f.local.planner.enqueueCreation(scheduleRequest('schedule1'))
  const local = await f.reopen()
  assert.equal(await local.setting('parent', 'planner-schedule-draft:h1'), null)
  assert.equal((await local.planner.get('parent', 'h1')).routines[0].complete_older_occurrences_on_new, true)
  assert.deepEqual(JSON.parse((await local.planner.get('parent', 'h1')).routines[0].recurrence_rule), dailySchedule.rules)
  assert.deepEqual(await local.planner.creations('other'), [])
  await assert.rejects(local.planner.enqueueCreation(scheduleRequest('schedule2')), /already has a saved schedule/)
  await assert.rejects(local.planner.acknowledgeCreation('parent', 'schedule1', { routine: { id: 'r1', household_id: 'other' } }), /did not match/)
  assert.equal((await local.planner.creations('parent')).length, 1)
  await local.planner.acknowledgeCreation('parent', 'schedule1', { routine: { id: 'r1', household_id: 'h1', recurrence_rule: JSON.stringify(dailySchedule.rules), complete_older_occurrences_on_new: true } })
  assert.equal((await local.planner.creations('parent')).length, 0)
  assert.equal((await local.planner.get('parent', 'h1')).routines[0].complete_older_occurrences_on_new, true)
})

test('P19 rejected schedule review retains intended changes and atomically replaces only the reviewed request', async t => {
  const f = await fixture(t)
  await f.local.planner.enqueueCreation(scheduleRequest('schedule1'))
  const queued = (await f.local.planner.creations('parent'))[0]
  await f.local.planner.failCreation(queued, 'Changed on another device', true, Date.now())
  const fresh = snapshot(); fresh.routines[0].recurrence_rule = JSON.stringify([{ ...dailySchedule.rules[0], time: '11:00' }])
  const controller = new PlannerController(f.local.planner, 'parent', 'device', { planner: async () => fresh }, () => 'reviewed')
  t.after(() => controller.stop())
  await controller.selectHousehold(household); controller.setConnectivity(true)
  const draft = await controller.reviewSchedule(queued)
  controller.setConnectivity(false)
  assert.equal(draft.baseSchedule.rules[0].time, '11:00')
  assert.equal(draft.schedule.rules[0].time, '09:00')
  assert.equal(draft.replacesId, 'schedule1')
  await f.local.saveSetting('parent', 'planner-schedule-draft:h1', draft)
  f.adapter.fail = true
  await assert.rejects(controller.create('saveRoutineSchedule', { routineId: draft.routineId, baseSchedule: draft.baseSchedule, schedule: draft.schedule }, 'Schedule', draft.replacesId), /Disk full/)
  assert.equal((await f.local.planner.creations('parent'))[0].id, 'schedule1', 'failed replacement leaves the old request')
  assert.equal((await f.local.setting('parent', 'planner-schedule-draft:h1')).replacesId, 'schedule1')
  f.adapter.fail = false
  await controller.create('saveRoutineSchedule', { routineId: draft.routineId, baseSchedule: draft.baseSchedule, schedule: draft.schedule }, 'Schedule', draft.replacesId)
  assert.equal((await f.local.planner.creations('parent'))[0].id, 'reviewed')
  assert.equal(await f.local.setting('parent', 'planner-schedule-draft:h1'), null)
  await f.local.planner.acknowledgeCreation('parent', 'schedule1')
  assert.equal((await f.local.planner.creations('parent'))[0].id, 'reviewed', 'a late reply cannot delete its replacement')
  await assert.rejects(f.local.planner.enqueueCreation(scheduleRequest('replacement'), 'reviewed'), /has changed/, 'an uncertain request cannot be replaced')
})

test('P20 discarding a rejected schedule restores the household version and does not resurrect removed routines', async t => {
  const f = await fixture(t)
  await f.local.planner.enqueueCreation(scheduleRequest('schedule1'))
  const queued = (await f.local.planner.creations('parent'))[0]
  await f.local.planner.failCreation(queued, 'Rejected', true, Date.now())
  await f.local.planner.discardCreation('parent', queued.id)
  assert.equal((await f.local.planner.get('parent', 'h1')).routines[0].recurrence_rule, undefined)
  await f.local.planner.enqueueCreation(scheduleRequest('schedule2'))
  await f.local.planner.cache('parent', 'h1', { ...snapshot(), routines: [] })
  assert.deepEqual((await f.local.planner.get('parent', 'h1')).routines, [])
})
