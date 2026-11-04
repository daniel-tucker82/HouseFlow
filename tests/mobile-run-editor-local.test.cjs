/* eslint-disable @typescript-eslint/no-require-imports -- Real SQLite and native editor services. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite'), { buildSync } = require('esbuild'), Module = require('node:module')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const loaded = new Module(__filename, module)
loaded._compile(buildSync({ stdin: { contents: 'export * from "./mobile/src/storage/local-store"; export * from "./mobile/src/services/run-editor-controller"; export * from "./mobile/src/services/board-controller"; export * from "./mobile/src/services/runs-controller"; export * from "./mobile/src/storage/sync-engine";', resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, __filename)
const { LocalStore, RunEditorController, BoardController, RunsController, TransportError } = loaded.exports
const household = { id: 'h1', name: 'Home', role: 'manager', leaderId: 'parent', timezone: 'Australia/Sydney' }
function snapshot(occurrenceId = 'run1') {
  return { householdId: 'h1', occurrence: { id: occurrenceId, household_id: 'h1', routine_id: null, title: 'Saturday', status: 'active' },
    tasks: [{ id: 'task1', household_id: 'h1', routine_id: null, routine_occurrence_id: occurrenceId, title: 'Pack bag', description: 'Original', is_reward: false, status: 'unlocked', assignee_id: 'child', scheduled_time: null,
      unlock_at: '2026-11-04T01:00:00Z', expires_at: '2026-11-05T01:00:00Z', position_y: 80 }], members: [{ id: 'child', name: 'Alex' }], taskAssignees: [{ task_id: 'task1', user_id: 'child' }], dependencies: [] }
}
function draft(patch = {}) { return { taskId: 'task1', occurrenceId: 'run1', routineId: null, isNew: false, title: 'Pack lunch', notes: 'New notes', isReward: false, assigneeIds: ['child'], prerequisiteIds: [], ...patch } }
function reply(edit) { return { task: { ...snapshot().tasks[0], id: edit.draft.taskId, title: edit.draft.title, description: edit.draft.notes, routine_occurrence_id: edit.draft.occurrenceId, assignee_ids: edit.draft.assigneeIds, prerequisite_ids: edit.draft.prerequisiteIds } } }
class Adapter {
  constructor(file) { this.db = new DatabaseSync(file); this.tail = Promise.resolve(); this.fail = null }
  async execAsync(sql) { this.db.exec(sql) }
  async runAsync(sql, ...params) { if (this.fail && sql.includes(this.fail)) throw Error('Disk full'); return this.db.prepare(sql).run(...params) }
  async getFirstAsync(sql, ...params) { return this.db.prepare(sql).get(...params) ?? null }
  async getAllAsync(sql, ...params) { return this.db.prepare(sql).all(...params) }
  withExclusiveTransactionAsync(work) {
    const result = this.tail.then(async () => { this.db.exec('BEGIN IMMEDIATE'); try { await work(this); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error } })
    this.tail = result.catch(() => {}); return result
  }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-live-editor-')), file = path.join(dir, 'local.db')
  let db = new Adapter(file), local = new LocalStore(db); await local.initialize(); await local.reconcileHouseholds('parent', [household])
  await local.runEditor.cache('parent', 'h1', 'run1', snapshot())
  await local.runEditor.cache('parent', 'h1', 'run2', snapshot('run2'))
  await local.planner.cache('parent', 'h1', { householdId: 'h1', tasks: [{ id: 'template', title: 'Template' }], routines: [], dependencies: [], taskAssignees: [], members: [], occurrences: [] })
  t.after(async () => { await db.tail; db.db.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }) })
  return { get local() { return local }, get db() { return db }, reopen: async () => { await db.tail; db.db.close(); db = new Adapter(file); local = new LocalStore(db); await local.initialize(); return local } }
}
function until(controller, predicate) {
  if (predicate(controller.getSnapshot())) return Promise.resolve()
  return new Promise(resolve => { const stop = controller.subscribe(() => { if (predicate(controller.getSnapshot())) { stop(); resolve() } }) })
}

async function cacheViews(f) {
  const task = { id: 'task1', occurrence_id: 'run1', occurrence_title: 'Saturday', occurrence_kind: 'manual', title: 'Pack bag', description: 'Original',
    status: 'unlocked', status_version: '23', assignee_ids: ['child'], is_reward: false, lock_type: 'none', blocking_task_title: null,
    unlock_at: '2026-11-04T01:00:00Z', expires_at: '2026-11-05T01:00:00Z' }
  const dependent = { ...task, id: 'dependent', title: 'After bag', status: 'locked', lock_type: 'prerequisite', blocking_task_id: 'task1', blocking_task_title: 'Pack bag', blocking_task_assignee_ids: ['child'] }
  const board = { household, members: snapshot().members, tasks: [task, dependent, { ...task, occurrence_id: 'run2' }], fetchedAt: new Date().toISOString() }
  const run = { ...board, tasks: [task, dependent], run: { id: 'run1', title: 'Saturday', routine_id: null, kind: 'manual', status: 'active', total_tasks: 2, completed_tasks: 0, scheduled_for: board.fetchedAt } }
  await f.local.cacheBoard('parent', board); await f.local.cacheRun('parent', run)
  await f.local.cacheRunPage('parent', { householdId: 'h1', view: 'active', items: [run.run], nextCursor: null, fetchedAt: board.fetchedAt })
  return { task, board, run }
}

test('pending live metadata appears across cached task screens through restart and refresh without altering task state', async t => {
  const f = await fixture(t), { board, run } = await cacheViews(f)
  await f.local.cacheBoard('another', board)
  const value = draft({ title: 'New bag name', notes: 'New note', assigneeIds: ['parent'], isReward: true,
    timing: { unlockRule: null, expiryRule: null, unlockCombiner: 'and' } })
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'metadata1', value)
  await f.reopen()
  // Even an older network snapshot must retain the durable overlay.
  await f.local.cacheBoard('parent', board); await f.local.cacheRun('parent', run)
  for (const view of [await f.local.getBoard('parent', 'h1'), await f.local.getRun('parent', 'h1', 'run1'), (await f.local.getBoards('parent'))[0]]) {
    const changed = view.tasks.find(task => task.id === 'task1' && task.occurrence_id === 'run1')
    assert.equal(changed.title, 'New bag name'); assert.equal(changed.description, 'New note'); assert.equal(changed.is_reward, true)
    assert.deepEqual(changed.assignee_ids, ['parent']); assert.equal(changed.metadata_sync, 'pending')
    assert.equal(changed.status, 'unlocked'); assert.equal(changed.status_version, '23'); assert.equal(changed.unlock_at, board.tasks[0].unlock_at)
    assert.equal(changed.expires_at, board.tasks[0].expires_at)
    const dependent = view.tasks.find(task => task.id === 'dependent')
    assert.equal(dependent.blocking_task_title, 'New bag name'); assert.deepEqual(dependent.blocking_task_assignee_ids, ['parent']); assert.equal(dependent.status, 'locked')
  }
  assert.equal((await f.local.getBoard('parent', 'h1')).tasks.find(task => task.occurrence_id === 'run2').title, 'Pack bag')
  assert.equal((await f.local.getBoard('another', 'h1')).tasks[0].title, 'Pack bag')
  await f.local.enqueueCompletion({ id: 'completed1', accountId: 'parent', householdId: 'h1', deviceId: 'device', taskId: 'task1', occurrenceId: 'run1', memberId: 'child', completed: true, deviceTimeMs: Date.now() })
  assert.equal((await f.local.getRun('parent', 'h1', 'run1')).tasks[0].status, 'completed')
  assert.equal((await f.local.getRun('parent', 'h1', 'run1')).run.completed_tasks, 1)
  const edit = (await f.local.runEditor.pending('parent'))[0]
  await f.local.runEditor.fail(edit, 'Review assignment', true)
  assert.equal((await f.local.getBoard('parent', 'h1')).tasks[0].metadata_sync, 'rejected')
  await f.local.runEditor.retry('parent', edit)
  assert.equal((await f.local.getBoard('parent', 'h1')).tasks[0].metadata_sync, 'pending')
  await f.local.reconcileHouseholds('parent', [{ ...household, role: 'member' }])
  const revoked = (await f.local.getBoard('parent', 'h1')).tasks[0]
  assert.equal(revoked.title, 'Pack bag'); assert.equal(revoked.metadata_sync, undefined)
})

test('metadata acknowledgement and discard update every server cache atomically and retain completion intent', async t => {
  const f = await fixture(t), { board } = await cacheViews(f)
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'metadata1', draft())
  let edit = (await f.local.runEditor.pending('parent'))[0]
  await f.local.enqueueCompletion({ id: 'completed1', accountId: 'parent', householdId: 'h1', deviceId: 'device', taskId: 'task1', occurrenceId: 'run1', memberId: 'child', completed: true, deviceTimeMs: Date.now() })
  f.db.fail = 'INSERT INTO run_snapshots'
  await assert.rejects(f.local.runEditor.acknowledge(edit, reply(edit)), /Disk full/)
  assert.equal((await f.local.runEditor.pending('parent')).length, 1)
  const base = JSON.parse(f.db.db.prepare('SELECT data FROM board_snapshots WHERE account_id=?').get('parent').data)
  assert.equal(base.server.tasks[0].title, 'Pack bag', 'a partial cache acknowledgement rolls back')
  f.db.fail = null
  await f.local.runEditor.acknowledge(edit, { task: { ...reply(edit).task, title: 'Authoritative version', assignee_id: null, assignee_ids: [] } })
  await f.reopen()
  for (const view of [await f.local.getBoard('parent', 'h1'), await f.local.getRun('parent', 'h1', 'run1')]) {
    assert.equal(view.tasks[0].title, 'Authoritative version'); assert.deepEqual(view.tasks[0].assignee_ids, [])
    assert.equal(view.tasks[0].metadata_sync, undefined); assert.equal(view.tasks[0].status, 'completed'); assert.equal(view.tasks[0].status_version, '23')
    assert.equal(view.tasks.find(task => task.id === 'dependent').blocking_task_title, 'Authoritative version')
  }
  assert.equal((await f.local.pending('parent')).length, 1)
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'metadata2', draft({ title: 'Rejected title' }))
  edit = (await f.local.runEditor.pending('parent'))[0]; await f.local.runEditor.fail(edit, 'Review', true)
  const fresh = snapshot(); fresh.tasks[0].title = 'Current household version'
  await f.local.runEditor.discard('parent', edit, fresh)
  assert.equal((await f.local.getBoard('parent', 'h1')).tasks[0].title, 'Current household version')
  assert.equal((await f.local.getRun('parent', 'h1', 'run1')).tasks[0].status, 'completed')
  assert.equal((await f.local.getBoard('parent', 'h1')).tasks.find(task => task.occurrence_id === 'run2').title, board.tasks[2].title)
})

test('controller publishes pending metadata without a network dependency and fences a pre-acknowledgement refresh', { timeout: 5000 }, async t => {
  const f = await fixture(t), { board: original, run } = await cacheViews(f), requests = []
  const board = new BoardController(f.local, 'parent', 'device', { bootstrap: () => new Promise(resolve => requests.push(resolve)) }, () => 'completion1')
  const runs = new RunsController(f.local, 'parent', { runs: async () => { throw Error('Unexpected network request') } }, board)
  const unsubscribe = board.subscribe(() => runs.observe(board.getSnapshot()))
  const editor = new RunEditorController(f.local.runEditor, 'parent', 'device', { runEditor: async () => snapshot(), saveRunEdit: async edit => reply(edit) }, () => 'metadata1', undefined,
    () => { board.invalidateRunReads(); runs.invalidateCreationReads() }, undefined,
    async () => { runs.invalidateCreationReads(); await board.reloadAfterRunChange() })
  t.after(() => { unsubscribe(); editor.stop(); runs.stop(); board.stop() })
  await board.start(); await runs.openRun('run1'); await editor.open(household, 'run1')
  await editor.save(draft())
  await until(board, state => state.board?.tasks[0].title === 'Pack lunch')
  await until(runs, state => state.run?.tasks[0].title === 'Pack lunch')
  assert.equal(requests.length, 0); assert.equal(board.getSnapshot().board.tasks[0].metadata_sync, 'pending')
  board.setConnectivity(true)
  assert.equal(requests.length, 1)
  editor.setConnectivity(true)
  await until(editor, state => state.pending.length === 0)
  requests[0]({ households: [household], board: original })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await f.local.getBoard('parent', 'h1')).tasks[0].title, 'Pack lunch')
  assert.equal((await f.local.getRun('parent', 'h1', 'run1')).run.total_tasks, run.run.total_tasks)
})

test('run acknowledgement invalidation fences local reads started before its transaction', async t => {
  const f = await fixture(t); await cacheViews(f)
  const board = new BoardController(f.local, 'parent', 'device', {}, () => 'unused')
  t.after(() => board.stop()); await board.start()
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'metadata1', draft())
  await board.reloadAfterRunChange()
  const visible = board.getSnapshot().board, read = f.local.getBoard.bind(f.local)
  let release
  f.local.getBoard = async (...args) => { const captured = await read(...args); return new Promise(resolve => { release = () => resolve(captured) }) }
  const earlierRead = board.reloadAfterRunChange()
  await new Promise(resolve => setImmediate(resolve))
  // A receipt invalidates readers before changing the cache/outbox atomically.
  board.invalidateRunReads()
  const edit = (await f.local.runEditor.pending('parent'))[0]
  await f.local.runEditor.acknowledge(edit, { task: { ...reply(edit).task, title: 'Confirmed name' } })
  release(); await earlierRead
  assert.equal(board.getSnapshot().board, visible, 'an old read cannot publish between acknowledgement and the next local read')
  f.local.getBoard = read; await board.reloadAfterRunChange()
  assert.equal(board.getSnapshot().board.tasks[0].title, 'Confirmed name')
  assert.equal(board.getSnapshot().board.tasks[0].metadata_sync, undefined)
})

test('live edits and drafts survive restart without changing templates, another run or another account', async t => {
  const f = await fixture(t)
  await f.local.runEditor.saveDraft('parent', 'h1', 'run1', draft())
  await f.reopen(); assert.equal((await f.local.runEditor.draft('parent', 'h1', 'run1')).title, 'Pack lunch')
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'edit1', draft(), 1234)
  await f.reopen()
  const data = await f.local.runEditor.get('parent', 'h1', 'run1'), queued = (await f.local.runEditor.pending('parent'))[0]
  assert.equal(data.tasks[0].title, 'Pack lunch'); assert.equal(data.tasks[0].position_y, 80)
  assert.equal(data.tasks[0].expires_at, snapshot().tasks[0].expires_at)
  assert.equal(queued.deviceTimeMs, 1234); assert.equal(await f.local.runEditor.draft('parent', 'h1', 'run1'), null)
  assert.equal((await f.local.runEditor.get('parent', 'h1', 'run2')).tasks[0].title, 'Pack bag')
  assert.equal((await f.local.planner.get('parent', 'h1')).tasks[0].title, 'Template')
  assert.deepEqual(await f.local.runEditor.pending('another'), []); assert.equal(await f.local.runEditor.get('another', 'h1', 'run1'), null)
  await assert.rejects(f.local.runEditor.cache('parent', 'h1', 'run1', snapshot('run2')), /did not match/)
  await assert.rejects(f.local.runEditor.saveDraft('parent', 'h1', 'run1', draft({ occurrenceId: 'run2' })), /does not belong/)
})

test('failed local writes roll back the queue, cache, draft removal and acknowledgement together', async t => {
  const f = await fixture(t)
  await f.local.runEditor.saveDraft('parent', 'h1', 'run1', draft())
  f.db.fail = 'INSERT INTO run_editor_snapshots'
  await assert.rejects(f.local.runEditor.enqueue('parent', 'h1', 'device', 'edit1', draft()), /Disk full/)
  assert.deepEqual(await f.local.runEditor.pending('parent'), [])
  assert.equal((await f.local.runEditor.draft('parent', 'h1', 'run1')).title, 'Pack lunch')
  assert.equal((await f.local.runEditor.get('parent', 'h1', 'run1')).tasks[0].title, 'Pack bag')
  f.db.fail = null; await f.local.runEditor.enqueue('parent', 'h1', 'device', 'edit1', draft())
  const edit = (await f.local.runEditor.pending('parent'))[0]
  await assert.rejects(f.local.runEditor.acknowledge(edit, { task: { ...reply(edit).task, routine_occurrence_id: 'run2' } }), /did not match/)
  f.db.fail = 'INSERT INTO run_editor_snapshots'
  await assert.rejects(f.local.runEditor.acknowledge(edit, reply(edit)), /Disk full/)
  assert.equal((await f.local.runEditor.pending('parent')).length, 1)
  f.db.fail = null; await f.local.runEditor.acknowledge(edit, reply(edit))
  await f.reopen(); assert.deepEqual(await f.local.runEditor.pending('parent'), [])
  assert.equal((await f.local.runEditor.get('parent', 'h1', 'run1')).tasks[0].title, 'Pack lunch')
})

test('coalescing retains timing and exact overrides; late replies cannot erase a newer revision', async t => {
  const f = await fixture(t), timing = { unlockRule: { kind: 'after_generation_days', days: 1 }, expiryRule: null, unlockCombiner: 'and' }
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'timing', draft({ timing, unlockAtOverride: '2026-11-06T10:00:00Z' }))
  const first = (await f.local.runEditor.pending('parent'))[0]
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'rename', draft({ title: 'Newest name' }))
  await f.local.runEditor.acknowledge(first, reply(first))
  const next = (await f.local.runEditor.pending('parent'))[0]
  assert.ok(next.revision > first.revision); assert.equal(next.id, 'rename'); assert.deepEqual(next.draft.timing, timing)
  assert.equal(next.draft.unlockAtOverride, '2026-11-06T10:00:00Z')
  await f.local.runEditor.cache('parent', 'h1', 'run1', snapshot())
  assert.equal((await f.local.runEditor.get('parent', 'h1', 'run1')).tasks[0].title, 'Newest name')
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'clear', draft({ timing: { unlockRule: null, expiryRule: null, unlockCombiner: 'and' } }))
  assert.equal((await f.local.runEditor.pending('parent'))[0].draft.unlockAtOverride, undefined)
})

test('new task requests are immutable across retries, cannot be discarded while uncertain, and do not duplicate on acknowledgement', async t => {
  const f = await fixture(t), fresh = draft({ taskId: 'new', isNew: true })
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'new1', fresh)
  const edit = (await f.local.runEditor.pending('parent'))[0]
  await assert.rejects(f.local.runEditor.enqueue('parent', 'h1', 'device', 'new2', { ...fresh, title: 'Different' }), /Wait for/)
  await assert.rejects(f.local.runEditor.enqueue('parent', 'h1', 'device', 'dependent', draft({ taskId: 'dependent', isNew: true, prerequisiteIds: ['new'] })), /finish syncing/)
  await f.local.runEditor.discard('parent', edit, null); assert.equal((await f.local.runEditor.pending('parent')).length, 1)
  await f.local.runEditor.fail(edit, 'Reply lost', false); await f.reopen()
  assert.deepEqual((await f.local.runEditor.pending('parent'))[0].draft, fresh)
  await f.local.runEditor.acknowledge(edit, reply(edit)); await f.local.runEditor.acknowledge(edit, reply(edit))
  assert.equal((await f.local.runEditor.get('parent', 'h1', 'run1')).tasks.filter(task => task.id === 'new').length, 1)
})

test('revoked access and deleted runs fence in-flight replies and retain rejected requests for review', async t => {
  const f = await fixture(t)
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'edit1', draft())
  const edit = (await f.local.runEditor.pending('parent'))[0]
  await f.local.removeRun('parent', 'h1', 'run1')
  await f.local.runEditor.acknowledge(edit, reply(edit))
  assert.equal(await f.local.runEditor.get('parent', 'h1', 'run1'), null)
  assert.equal((await f.local.runEditor.pending('parent'))[0].state, 'rejected')
  await f.local.runEditor.discard('parent', edit, null)
  await f.local.runEditor.saveDraft('parent', 'h1', 'run2', draft({ occurrenceId: 'run2' }))
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'edit2', draft({ occurrenceId: 'run2' }))
  const second = (await f.local.runEditor.pending('parent'))[0]
  await f.local.reconcileHouseholds('parent', [{ ...household, role: 'member' }])
  await f.local.runEditor.acknowledge(second, reply(second))
  assert.equal(await f.local.runEditor.get('parent', 'h1', 'run2'), null)
  await assert.rejects(f.local.runEditor.retry('parent', second), /Parent access/)
  await assert.rejects(f.local.runEditor.retry('someone-else', second), /Sign back/)
  await f.local.runEditor.discard('parent', second, null); assert.deepEqual(await f.local.runEditor.pending('parent'), [])
})

test('controller saves without waiting for upload, resumes after restart, and ignores old refreshes', { timeout: 5000 }, async t => {
  const f = await fixture(t), uploads = [], reads = []
  let controller = new RunEditorController(f.local.runEditor, 'parent', 'device', {
    runEditor: () => new Promise(resolve => reads.push(resolve)), saveRunEdit: edit => new Promise(resolve => uploads.push({ edit, resolve })),
  }, () => 'save1')
  await controller.open(household, 'run1'); controller.setConnectivity(true)
  await controller.save(draft()); await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.getSnapshot().pending.length, 1); assert.equal(controller.getSnapshot().busy, false)
  assert.equal(uploads.length, 1)
  for (const resolve of reads.splice(0)) resolve(snapshot())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.getSnapshot().data.tasks[0].title, 'Pack lunch')
  controller.stop(); uploads[0].resolve(reply(uploads[0].edit)); await new Promise(resolve => setImmediate(resolve))
  await f.reopen()
  controller = new RunEditorController(f.local.runEditor, 'parent', 'device', {
    runEditor: async () => { const data = snapshot(); data.tasks[0].title = 'Pack lunch'; return data },
    saveRunEdit: async edit => { assert.equal(edit.id, 'save1'); return reply(edit) },
  }, () => 'unused')
  t.after(() => controller.stop())
  await controller.start(); controller.setConnectivity(true)
  await until(controller, state => state.pending.length === 0)
  assert.deepEqual(await f.local.runEditor.pending('parent'), [])
})

test('a failed draft write remains visible through unrelated refreshes and a rejected edit can be reviewed', async t => {
  const f = await fixture(t), controller = new RunEditorController(f.local.runEditor, 'parent', 'device', { runEditor: async () => snapshot(), saveRunEdit: async () => { throw new TransportError('Premium required', 402) } }, () => 'edit1')
  t.after(() => controller.stop()); await controller.open(household, 'run1')
  f.db.fail = 'INSERT INTO device_settings'
  await assert.rejects(controller.setDraft(draft({ title: 'Do not lose me' })), /Disk full/)
  controller.observe(household); await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.getSnapshot().draft.title, 'Do not lose me'); assert.match(controller.getSnapshot().error, /Draft not saved/)
  f.db.fail = null; await controller.setDraft(draft()); controller.setConnectivity(true); await controller.save(draft())
  await until(controller, state => state.pending[0]?.state === 'rejected')
  await controller.discard(controller.getSnapshot().pending[0])
  assert.deepEqual(controller.getSnapshot().pending, []); assert.equal(controller.getSnapshot().data.tasks[0].title, 'Pack bag')
})

test('kiosk activation accounts for live drafts and queued writes, then purges the live editor cache', async t => {
  const f = await fixture(t), hh = randomUUID(), occurrenceId = randomUUID(), home = { ...household, id: hh }
  const data = snapshot(occurrenceId); data.householdId = hh; data.occurrence.household_id = hh; data.tasks[0].household_id = hh
  await f.local.reconcileHouseholds('parent', [household, home]); await f.local.runEditor.cache('parent', hh, occurrenceId, data)
  await f.local.cacheBoard('parent', { household: home, members: data.members, tasks: [], fetchedAt: '2026-11-04T01:00:00Z' })
  const kiosk = { id: randomUUID(), accountId: 'parent', sessionId: 'sess_parent', deviceId: randomUUID(), householdId: hh, visibleMemberIds: ['child'], editableMemberIds: ['child'], state: 'locked' }
  const value = draft({ occurrenceId })
  await f.local.runEditor.saveDraft('parent', hh, occurrenceId, value)
  await assert.rejects(f.local.kiosk.begin(kiosk), /drafts/)
  await f.local.runEditor.enqueue('parent', hh, 'device', 'edit1', value)
  await assert.rejects(f.local.kiosk.begin(kiosk), /Sync or review/)
  const edit = (await f.local.runEditor.pending('parent'))[0]
  await f.local.runEditor.fail(edit, 'Review', true); await f.local.runEditor.discard('parent', edit, data)
  await f.local.kiosk.begin(kiosk)
  assert.equal(await f.local.runEditor.get('parent', hh, occurrenceId), null)
  assert.equal((await f.db.getAllAsync('SELECT * FROM run_editor_snapshots')).length, 0)
  await assert.rejects(f.local.runEditor.cache('parent', hh, occurrenceId, data), /Parent access/)
})

test('acknowledgement uses authoritative assignments and links, while a recovered creation preserves a newer server snapshot', async t => {
  const f = await fixture(t), data = snapshot()
  data.tasks.push({ ...data.tasks[0], id: 'source', title: 'Source' })
  await f.local.runEditor.cache('parent', 'h1', 'run1', data)
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'edit1', draft())
  let edit = (await f.local.runEditor.pending('parent'))[0]
  await f.local.runEditor.acknowledge(edit, { task: { ...reply(edit).task, title: 'Server version', assignee_id: null, assignee_ids: [], prerequisite_ids: ['source'] } })
  let saved = await f.local.runEditor.get('parent', 'h1', 'run1')
  assert.equal(saved.tasks[0].title, 'Server version')
  assert.deepEqual(saved.taskAssignees, [])
  assert.deepEqual(saved.dependencies, [{ source_task_id: 'source', target_task_id: 'task1' }])

  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'new1', draft({ taskId: 'new', isNew: true }))
  edit = (await f.local.runEditor.pending('parent'))[0]
  data.tasks.push({ ...data.tasks[0], id: 'new', title: 'Changed on another device', assignee_id: null })
  data.dependencies = [{ source_task_id: 'source', target_task_id: 'new' }]
  await f.local.runEditor.cache('parent', 'h1', 'run1', data)
  await f.local.runEditor.acknowledge(edit, reply(edit))
  saved = await f.local.runEditor.get('parent', 'h1', 'run1')
  assert.equal(saved.tasks.find(task => task.id === 'new').title, 'Changed on another device')
  assert.deepEqual(saved.dependencies, data.dependencies)
  assert.deepEqual(saved.taskAssignees, data.taskAssignees)
})

test('confirmed task deletion is atomic across editor, Today, run details and saved changes without affecting another run', async t => {
  const f = await fixture(t), data = snapshot()
  data.tasks.push({ ...data.tasks[0], id: 'dependent' })
  data.dependencies = [{ source_task_id: 'task1', target_task_id: 'dependent' }]
  await f.local.runEditor.cache('parent', 'h1', 'run1', data)
  const task = { id: 'task1', occurrence_id: 'run1', title: 'Pack bag', status: 'unlocked', assignee_ids: ['child'], is_reward: false, lock_type: 'none' }
  const board = { household, members: data.members, tasks: [task, { ...task, occurrence_id: 'run2' }], fetchedAt: new Date().toISOString() }
  const run = { ...board, tasks: [task], run: { id: 'run1', title: 'Saturday', routine_id: null, kind: 'manual', status: 'active', total_tasks: 1, completed_tasks: 0 } }
  await f.local.cacheBoard('parent', board); await f.local.cacheRun('parent', run)
  await f.local.cacheRunPage('parent', { householdId: 'h1', view: 'active', items: [run.run], nextCursor: null, fetchedAt: board.fetchedAt })
  await f.local.enqueueCompletion({ id: 'complete1', accountId: 'parent', householdId: 'h1', deviceId: 'device', taskId: 'task1', occurrenceId: 'run1', memberId: 'child', completed: true, deviceTimeMs: Date.now() })
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'edit1', draft())
  const edit = (await f.local.runEditor.pending('parent'))[0]
  await f.local.runEditor.saveDraft('parent', 'h1', 'run1', draft())
  f.db.fail = 'UPDATE pending_completions'
  await assert.rejects(f.local.removeRunTask('parent', 'h1', 'run1', 'task1'), /Disk full/)
  assert.equal((await f.local.runEditor.get('parent', 'h1', 'run1')).tasks.length, 2)
  assert.ok(await f.local.runEditor.draft('parent', 'h1', 'run1'))
  f.db.fail = null
  await f.local.removeRunTask('parent', 'h1', 'run1', 'task1')
  await f.local.runEditor.acknowledge(edit, reply(edit))
  const saved = await f.local.runEditor.get('parent', 'h1', 'run1')
  assert.deepEqual(saved.tasks.map(task => task.id), ['dependent']); assert.deepEqual(saved.dependencies, [])
  assert.deepEqual(saved.taskAssignees, []); assert.equal(await f.local.runEditor.draft('parent', 'h1', 'run1'), null)
  assert.equal((await f.local.runEditor.pending('parent'))[0].state, 'rejected')
  assert.equal((await f.local.pending('parent'))[0].state, 'rejected')
  assert.deepEqual((await f.local.getBoard('parent', 'h1')).tasks.map(task => task.occurrence_id), ['run2'])
  assert.equal((await f.local.getRun('parent', 'h1', 'run1')).tasks.length, 0)
  assert.equal((await f.local.getRunPage('parent', 'h1', 'active')).items[0].total_tasks, 0)
  assert.equal((await f.local.runEditor.get('parent', 'h1', 'run2')).tasks.length, 1)
  assert.equal((await f.local.planner.get('parent', 'h1')).tasks[0].title, 'Template')
  await f.local.runEditor.enqueue('parent', 'h1', 'device', 'new1', draft({ taskId: 'new', isNew: true }))
  const fresh = (await f.local.runEditor.pending('parent')).find(edit => edit.id === 'new1')
  await f.local.removeRunTask('parent', 'h1', 'run1', 'new'); await f.local.runEditor.acknowledge(fresh, reply(fresh))
  assert.equal((await f.local.runEditor.get('parent', 'h1', 'run1')).tasks.some(task => task.id === 'new'), false)
})

test('navigation cancels pending open/delete admission; a submitted deletion still cleans its original cache', { timeout: 5000 }, async t => {
  const f = await fixture(t), store = f.local.runEditor, allowed = store.allowed.bind(store)
  let release, deleted, calls = 0
  const controller = new RunEditorController(store, 'parent', 'device', {
    runEditor: async (_, id) => snapshot(id), saveRunEdit: async edit => reply(edit),
    deleteRunTask: async () => { calls++; await new Promise(resolve => { deleted = resolve }) },
  }, () => 'unused', undefined, undefined, (hh, run, task) => f.local.removeRunTask('parent', hh, run, task))
  t.after(() => controller.stop())
  store.allowed = () => new Promise(resolve => { release = resolve })
  const opening = controller.open(household, 'run1'); controller.close(); release(true); await opening
  assert.equal(controller.getSnapshot().occurrenceId, null)
  store.allowed = allowed; await controller.open(household, 'run1')
  controller.setConnectivity(true); await controller.refresh()
  store.allowed = () => new Promise(resolve => { release = resolve })
  const cancelled = controller.deleteTask('task1'); controller.close(); release(true); await cancelled
  assert.equal(calls, 0)
  store.allowed = allowed; await controller.open(household, 'run1')
  const sending = controller.deleteTask('task1')
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1)
  await assert.rejects(controller.deleteTask('task1'), /Finish editing/)
  controller.close(); await controller.open(household, 'run2'); deleted(); await sending
  assert.equal(controller.getSnapshot().occurrenceId, 'run2')
  assert.equal(controller.getSnapshot().data.tasks.length, 1)
  assert.equal((await store.get('parent', 'h1', 'run1')).tasks.length, 0)
  controller.setConnectivity(false); await assert.rejects(controller.deleteTask('task1'), /Connect/)
  await controller.setDraft(draft({ occurrenceId: 'run2' })); controller.setConnectivity(true)
  await assert.rejects(controller.deleteTask('task1'), /Finish editing/)
})
