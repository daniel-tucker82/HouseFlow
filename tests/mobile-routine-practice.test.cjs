/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the shared practice model without a network or persistence runtime. */
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), Module = require('node:module')
const { buildSync } = require('esbuild')
const loaded = new Module(__filename, module)
loaded._compile(buildSync({ stdin: { contents: 'export * from "./shared/mobile/routine-practice"; export * from "./shared/routine-planner-graph"', resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, __filename)
const { createRoutinePractice, practiceTaskStates, completePracticeTask, resetRoutinePractice, orderPlannerTasks, prerequisiteClosure } = loaded.exports
const task = (id, routine_id = 'morning', extra = {}) => ({ id, household_id: 'family', routine_id, routine_occurrence_id: null,
  title: id, description: `Notes for ${id}`, is_reward: false, assignee_id: null, status: 'completed', scheduled_time: null, ...extra })
const edge = (source, target) => ({ source_task_id: source, target_task_id: target })
function snapshot() {
  return { householdId: 'family', routines: [{ id: 'morning', household_id: 'family', name: 'Morning' }, { id: 'evening', household_id: 'family', name: 'Evening' }],
    tasks: [task('reward', 'morning', { is_reward: true }), task('bag'), task('breakfast'), task('lunch', 'evening'), task('unrelated', 'evening')],
    dependencies: [edge('bag', 'reward'), edge('breakfast', 'reward'), edge('lunch', 'bag')],
    taskAssignees: [{ task_id: 'bag', user_id: 'alex' }, { task_id: 'bag', user_id: 'sam' }], members: [{ id: 'alex', name: 'Alex' }, { id: 'sam', name: 'Sam' }], occurrences: [] }
}
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child) }; return value }

test('practice includes cross-routine prerequisites in stable order and unlocks a reward only after every branch', () => {
  const source = freeze(snapshot()), before = JSON.stringify(source)
  let practice = createRoutinePractice(source, 'morning')
  assert.deepEqual(practice.tasks.map(task => task.id), ['breakfast', 'lunch', 'bag', 'reward'])
  assert.equal(practice.tasks.find(task => task.id === 'lunch').otherRoutine, 'Evening')
  assert.deepEqual(practice.tasks.find(task => task.id === 'bag').members, ['Alex', 'Sam'])
  assert.deepEqual(practiceTaskStates(practice).map(task => task.status), ['ready', 'ready', 'waiting', 'waiting'])
  assert.equal(completePracticeTask(practice, 'bag'), practice)
  practice = completePracticeTask(practice, 'lunch'); practice = completePracticeTask(practice, 'bag')
  assert.deepEqual(practiceTaskStates(practice).find(task => task.id === 'reward').waitingFor, ['breakfast'])
  practice = completePracticeTask(practice, 'breakfast'); practice = completePracticeTask(practice, 'reward')
  assert.ok(practiceTaskStates(practice).every(task => task.status === 'completed'))
  assert.equal(JSON.stringify(source), before, 'practice must never change templates or live state')
})

test('practice ignores live completion, time, expiry and OR time-combiner state, matching the existing task-order preview', () => {
  const source = snapshot()
  source.tasks[1].unlock_rule = { kind: 'fixed', date: '2099-01-01', time: '09:00' }
  source.tasks[1].unlock_at = '2099-01-01T09:00:00Z'; source.tasks[1].unlock_combiner = 'or'
  source.tasks[2].expires_at = '2000-01-01T00:00:00Z'
  const practice = createRoutinePractice(source, 'morning'), states = practiceTaskStates(practice)
  assert.equal(states.find(task => task.id === 'breakfast').status, 'ready')
  assert.equal(states.find(task => task.id === 'bag').status, 'waiting')
  assert.equal(practice.completed.length, 0)
  assert.equal(practiceTaskStates(completePracticeTask(practice, 'lunch')).find(task => task.id === 'bag').status, 'ready')
})

test('practice is detached from later refreshes; resetting/reopening never reopens a real task', () => {
  const source = snapshot(); source.tasks[3].assignee_id = 'alex'
  let practice = createRoutinePractice(source, 'morning')
  source.tasks[3].title = 'Changed remotely'; source.members[0].name = 'Changed member'; source.dependencies.length = 0; source.routines[0].name = 'Changed routine'
  assert.equal(practice.routineName, 'Morning'); assert.equal(practice.tasks.find(task => task.id === 'lunch').title, 'lunch')
  assert.deepEqual(practice.tasks.find(task => task.id === 'lunch').members, ['Alex'])
  practice = completePracticeTask(practice, 'lunch')
  assert.equal(completePracticeTask(practice, 'lunch'), practice, 'completed practice buttons do not reopen')
  assert.equal(completePracticeTask(practice, 'unknown'), practice)
  const reset = resetRoutinePractice(practice)
  assert.equal(reset.completed.length, 0); assert.equal(practice.completed.length, 1)
  assert.equal(createRoutinePractice(source, 'morning').completed.length, 0)
  assert.ok(source.tasks.every(task => task.status === 'completed'))
})

test('cycles, missing prerequisites and wrong-household/snapshot tasks cannot produce false completion', () => {
  const source = snapshot()
  source.dependencies.push(edge('reward', 'bag'), edge('missing', 'breakfast'), edge('foreign', 'lunch'))
  source.tasks.push(task('foreign', 'morning', { household_id: 'other', title: 'Private task' }), task('live', 'morning', { routine_occurrence_id: 'run' }))
  let practice = createRoutinePractice(source, 'morning')
  assert.ok(!practice.tasks.some(task => ['foreign', 'live'].includes(task.id)))
  assert.ok(practiceTaskStates(practice).every(task => task.status === 'waiting'))
  assert.deepEqual(practiceTaskStates(practice).find(task => task.id === 'lunch').waitingFor, ['Unavailable task'])
  for (const item of source.tasks) practice = completePracticeTask(practice, item.id)
  assert.equal(practice.completed.length, 0)
  assert.throws(() => createRoutinePractice({ ...source, householdId: 'other' }, 'morning'), /this household/)
  assert.throws(() => createRoutinePractice(source, 'missing'), /this household/)
})

test('empty templates and large prerequisite chains are retained without unrelated descendants or duplicate edges', () => {
  const source = snapshot(); source.tasks = []
  assert.deepEqual(createRoutinePractice(source, 'morning').tasks, [])
  const tasks = Array.from({ length: 1000 }, (_, i) => ({ id: `t${999-i}` }))
  const edges = Array.from({ length: 999 }, (_, i) => edge(`t${i}`, `t${i+1}`))
  edges.push(edge('t0', 't1'), edge('unavailable', 't0'), edge('t999', 'unrelated'))
  const ordered = orderPlannerTasks(tasks, edges)
  assert.deepEqual(ordered.map(task => task.id), Array.from({ length: 1000 }, (_, i) => `t${i}`))
  assert.equal(tasks[0].id, 't999')
  const closure = prerequisiteClosure(['t999'], edges)
  assert.equal(closure.size, 1001); assert.equal(closure.has('unrelated'), false)
})
