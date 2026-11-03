import test from 'node:test'
import assert from 'node:assert/strict'
import { TaskSaveQueue, TaskSaveFailure, overlayTaskEdits } from '../lib/task-save-queue.ts'

class MemoryStorage {
  data = new Map()
  get length() { return this.data.size }
  get editCount() { return [...this.data.keys()].filter(key => key.includes(":task-edits:")).length }
  key(i) { return [...this.data.keys()][i] ?? null }
  getItem(key) { return this.data.get(key) ?? null }
  setItem(key, value) { this.data.set(key, value) }
  removeItem(key) { this.data.delete(key) }
}
const edit = (title = 'New title', taskId = 'task-a') => ({ action: 'updateTask', householdId: 'household', taskId, title, notes: 'Notes', isReward: false, assigneeIds: ['person'] })
const task = (title = 'Old title', id = 'task-a') => ({ id, household_id: 'household', routine_id: 'routine', title, status: 'locked', is_reward: false, assignee_id: null, scheduled_time: null })
const tick = () => new Promise(resolve => setImmediate(resolve))
function setup(t, options = {}) {
  let now = 1000
  const storage = options.storage ?? new MemoryStorage()
  const sent = []
  const queue = new TaskSaveQueue(options.user ?? 'user-a', { storage, now: () => now, lock: options.lock ?? (work => work()), send: options.send ?? (async value => { sent.push(value); return task(value.title, value.taskId) }) })
  queue.start()
  t.after(() => queue.stop())
  return { queue, storage, sent, advance: amount => { now += amount } }
}

test('edits are durable and visible immediately, before the debounce or network', t => {
  const { queue, storage, sent } = setup(t)
  queue.enqueue(edit())
  assert.equal(storage.editCount, 1)
  assert.equal(queue.overlays('household', queue.revision)[0].patch.title, 'New title')
  assert.equal(sent.length, 0)
  assert.deepEqual(queue.overlays('another-household', 0), [])
})

test('an older in-flight response cannot overwrite or acknowledge a newer edit', async t => {
  const pending = [], sent = [], changes = []
  const { queue, storage } = setup(t, { send: value => { sent.push(value.title); return new Promise(resolve => pending.push(() => resolve(task(value.title)))) } })
  queue.onChange(save => changes.push(save.patch.title))
  queue.enqueue(edit('First'), 0)
  const saving = queue.drain()
  await tick()
  queue.enqueue(edit('Latest'), 0)
  assert.deepEqual(sent, ['First'])
  pending.shift()()
  await tick()
  assert.deepEqual(sent, ['First', 'Latest'])
  assert.deepEqual(changes, ['First', 'Latest'])
  assert.equal(storage.editCount, 1)
  pending.shift()()
  await saving
  assert.deepEqual(changes, ['First', 'Latest', 'Latest'])
  assert.equal(storage.editCount, 0)
})

test('rapid edits coalesce per task without losing edits when switching tasks', async t => {
  const { queue, sent } = setup(t)
  queue.enqueue(edit('A1')); queue.enqueue(edit('B', 'task-b')); queue.enqueue(edit('A2'))
  queue.flush()
  await queue.drain()
  assert.deepEqual(sent.map(value => value.title).sort(), ['A2', 'B'])
  assert.equal(queue.getSnapshot().length, 0)
})

test('a reload resumes saved edits, scoped to the original signed-in account', async t => {
  const first = setup(t)
  first.queue.enqueue(edit())
  first.queue.stop()
  const other = setup(t, { storage: first.storage, user: 'user-b' })
  assert.equal(other.queue.getSnapshot().length, 0)
  const reloaded = setup(t, { storage: first.storage })
  assert.equal(reloaded.queue.getSnapshot()[0].edit.title, 'New title')
  reloaded.queue.flush()
  await reloaded.queue.drain()
  assert.equal(reloaded.sent.length, 1)
})

for (const failure of [new TypeError('Offline'), new TaskSaveFailure('Busy', 429), new TaskSaveFailure('Unavailable', 503)]) {
  test(`temporary failure is retained and retried: ${failure.message}`, async t => {
    let attempts = 0
    const { queue, storage, advance } = setup(t, { send: async () => { if (++attempts === 1) throw failure; return task('New title') } })
    queue.enqueue(edit(), 0)
    await queue.drain()
    assert.equal(storage.editCount, 1)
    assert.equal(queue.getSnapshot()[0].state, 'retrying')
    advance(1000)
    await queue.drain()
    assert.equal(attempts, 2)
    assert.equal(storage.editCount, 0)
  })
}

test('validation failures remain recoverable and do not loop or block other tasks', async t => {
  let calls = 0
  const { queue, sent, storage } = setup(t, { send: async value => {
    calls++
    if (value.taskId === 'task-a') throw new TaskSaveFailure('Title too long', 400)
    sent.push(value); return task(value.title, value.taskId)
  } })
  queue.enqueue(edit(), 0); queue.enqueue(edit('B', 'task-b'), 0)
  await queue.drain()
  assert.equal(calls, 2)
  assert.equal(queue.getSnapshot()[0].state, 'error')
  assert.equal(storage.editCount, 1)
  await queue.drain()
  assert.equal(calls, 2)
})

test('storage failure does not publish an edit as safely queued', t => {
  const { queue, storage } = setup(t)
  storage.setItem = () => { throw new Error('Storage full') }
  assert.throws(() => queue.enqueue(edit()), /Storage full/)
  assert.equal(queue.getSnapshot().length, 0)
})

test('stale reads keep the new title after acknowledgement; fresh reads accept server changes', async t => {
  const { queue } = setup(t)
  const readRevision = queue.revision
  queue.enqueue(edit(), 0)
  await queue.drain()
  const stale = { tasks: [task()], allTasks: [{ id: 'task-a', title: 'Old title' }], taskAssignees: [], dependencies: [] }
  const projected = overlayTaskEdits(stale, queue.overlays('household', readRevision))
  assert.equal(projected.tasks[0].title, 'New title')
  assert.equal(projected.allTasks[0].title, 'New title')
  assert.equal(projected.taskAssignees[0].user_id, 'person')
  assert.equal(projected.tasks[0].status, 'locked')
  assert.deepEqual(queue.overlays('household', queue.revision), [])
})

test('shared storage and a cross-tab lock send each edit only once', async t => {
  let tail = Promise.resolve()
  const lock = work => { const current = tail.then(work); tail = current.catch(() => {}); return current }
  const first = setup(t, { lock })
  const second = setup(t, { lock, storage: first.storage })
  first.queue.enqueue(edit(), 0)
  await Promise.all([first.queue.drain(), second.queue.drain()])
  assert.equal(first.sent.length + second.sent.length, 1)
  assert.equal(first.storage.editCount, 0)
})

test('unmounting/signing out stops sending but preserves the durable edit', async t => {
  const { queue, sent, storage } = setup(t)
  queue.enqueue(edit(), 0)
  queue.stop()
  await queue.drain()
  assert.equal(sent.length, 0)
  assert.equal(storage.editCount, 1)
})

test('starting a routine waits for queued edits and reports save failures', async t => {
  let finish
  const { queue } = setup(t, { send: value => new Promise(resolve => { finish = () => resolve(task(value.title)) }) })
  queue.enqueue(edit())
  let ready = false
  const waiting = queue.waitForSaves('household').then(() => { ready = true })
  const saving = queue.drain()
  await tick()
  assert.equal(ready, false)
  finish()
  await Promise.all([saving, waiting])
  assert.equal(ready, true)
  const failed = setup(t, { send: async () => { throw new TaskSaveFailure('Denied', 403) } })
  failed.queue.enqueue(edit(), 0)
  await failed.queue.drain()
  await assert.rejects(failed.queue.waitForSaves('household'), /waiting to save/)
})

test('pending edits replay when returning to an editor without a fresh network read', t => {
  const { queue } = setup(t)
  queue.enqueue(edit())
  let visibleTitle
  const unsubscribe = queue.onChange(save => { visibleTitle = save.patch.title })
  assert.equal(visibleTitle, 'New title')
  unsubscribe()
})
