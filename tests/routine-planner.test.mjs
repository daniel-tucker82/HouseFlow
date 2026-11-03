import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import Module, { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const filename = fileURLToPath(new URL('../lib/routine-planner.ts', import.meta.url))
const loaded = new Module(filename)
loaded.require = createRequire(import.meta.url)
loaded._compile(buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, filename)
const { plannerTaskSchema, taskDescendants, orderPlannerTasks } = loaded.exports

const task = {
  taskId: 'b98ce792-81b7-4ceb-bbb2-1a17c8134901',
  routineId: '41147524-744a-4565-9e9c-f1e3966596d7',
  isNew: true, title: 'Pack a bag', notes: '', isReward: false,
  assigneeIds: ['alex', 'sam'], prerequisiteIds: [],
}
const edges = [
  { source_task_id: 'breakfast', target_task_id: 'teeth' },
  { source_task_id: 'teeth', target_task_id: 'play' },
  { source_task_id: 'bag', target_task_id: 'play' },
]

test('shared tasks retain every assignee, including non-account household members', () => {
  assert.deepEqual(plannerTaskSchema.parse(task).assigneeIds, ['alex', 'sam'])
})
test('empty titles, malformed IDs and self prerequisites are rejected', () => {
  for (const patch of [{ title: '  ' }, { taskId: 'not-an-id' }, { prerequisiteIds: [task.taskId] }]) {
    assert.equal(plannerTaskSchema.safeParse({ ...task, ...patch }).success, false)
  }
})
test('unassigned tasks remain supported for existing planning workflows', () => {
  assert.equal(plannerTaskSchema.safeParse({ ...task, assigneeIds: [] }).success, true)
})
test('all downstream tasks are excluded as prerequisites, without blocking independent branches', () => {
  assert.deepEqual([...taskDescendants(edges, 'breakfast')], ['breakfast', 'teeth', 'play'])
  assert.equal(taskDescendants(edges, 'breakfast').has('bag'), false)
})
test('ordering puts every prerequisite before its dependent task', () => {
  const tasks = ['play', 'teeth', 'bag', 'breakfast'].map(id => ({ id }))
  const ids = orderPlannerTasks(tasks, edges).map(item => item.id)
  for (const edge of edges) assert.ok(ids.indexOf(edge.source_task_id) < ids.indexOf(edge.target_task_id))
})
test('legacy cycles do not hang or hide tasks', () => {
  const cyclic = [...edges, { source_task_id: 'play', target_task_id: 'breakfast' }]
  const tasks = ['play', 'teeth', 'bag', 'breakfast'].map(id => ({ id }))
  assert.equal(taskDescendants(cyclic, 'breakfast').size, 3)
  assert.equal(orderPlannerTasks(tasks, cyclic).length, tasks.length)
})
