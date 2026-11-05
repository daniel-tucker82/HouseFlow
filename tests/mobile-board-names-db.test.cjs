/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL reads through native routes and transport. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { fixture, connectionString } = require('./helpers/account-deletion.cjs')

test('Today, run lists and run details resolve the same household-scoped board names without rewriting storage', { skip: !connectionString }, async t => {
  const f = await fixture(t)
  const template = (await f.db.query('select id from routines where household_id=$1', [f.transfer])).rows[0].id
  const foreign = (await f.db.query('select id from routines where household_id=$1', [f.shared])).rows[0].id
  await f.db.query("update routines set name='Morning routine' where id=$1", [template])
  await f.db.query("update routines set name='Private other household name' where id=$1", [foreign])
  await f.db.query('delete from household_members where household_id=$1 and user_id=$2', [f.shared, f.owner])
  const cases = [
    { title: null, routine: template, kind: 'routine', expected: 'Morning routine' },
    { title: `Recurrence - ${randomUUID()}`, routine: template, kind: 'routine', expected: 'Morning routine' },
    { title: 'Recurrence - legacy-rule-1', routine: template, kind: 'routine', expected: 'Morning routine' },
    { title: 'School day', routine: template, kind: 'routine', expected: 'School day' },
    { title: 'Recurrence - chores', routine: null, kind: 'manual', expected: 'Recurrence - chores' },
    { title: '  ', routine: null, kind: 'manual', expected: 'Task board' },
    { title: null, routine: null, kind: 'routine', expected: 'Routine' },
    { title: null, routine: foreign, kind: 'routine', expected: 'Routine' },
    { title: '  ', routine: template, kind: 'routine', expected: 'Morning routine' },
  ]
  for (const item of cases) {
    item.id = randomUUID(); item.task = randomUUID()
    await f.db.query("insert into routine_occurrences(id,household_id,routine_id,kind,title,scheduled_for) values($1,$2,$3,$4,$5,now())", [item.id, f.transfer, item.routine, item.kind, item.title])
    await f.db.query("insert into tasks(id,household_id,routine_occurrence_id,title) values($1,$2,$3,'Brush teeth')", [item.task, f.transfer, item.id])
    await f.db.query("insert into occurrence_tasks(occurrence_id,task_id,status) values($1,$2,'unlocked')", [item.id, item.task])
    await f.db.query('insert into task_assignees(task_id,user_id) values($1,$2)', [item.task, f.successor])
  }
  const submittedNotifications = []
  const mocks = {
    'next/navigation': { redirect: () => assert.fail('Read unexpectedly redirected') },
    'next/server': { NextResponse: { json: Response.json }, after() {} },
    '@/lib/user-sync': { ensureCurrentUserRecord: async () => {} },
    '@/lib/push': { dispatchPushForNotificationIds: async ids => { submittedNotifications.push(...ids) } },
  }
  const bootstrap = f.load(['app/api/mobile/bootstrap/route.ts'], mocks).GET
  const runs = f.load(['app/api/mobile/runs/route.ts'], mocks).GET
  const { getHouseholdMemberViewData } = f.load(['lib/data.ts'], mocks)
  const { MobileApi } = f.load(['mobile/src/services/api.ts'])
  const originalFetch = global.fetch; t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url, init) => {
    assert.equal(new URL(url).origin, 'https://fixture.cyntch.test')
    const handler = new URL(url).pathname === '/api/mobile/bootstrap' ? bootstrap : runs
    return handler(new Request(url, init))
  }
  const api = new MobileApi('https://fixture.cyntch.test', f.owner, f.scope.deviceId, async () => 'fixture', async () => f.secret, f.scope.sessionId)
  const taskRows = async () => (await f.db.query(
    'select task_id, xmin::text as version from occurrence_tasks where task_id=any($1::uuid[]) order by task_id',
    [cases.map(item => item.task)])).rows
  const beforeReads = await taskRows()
  const today = await api.bootstrap(f.transfer), list = await api.runs(f.transfer, 'active')
  const web = await getHouseholdMemberViewData(f.transfer, f.owner)
  assert.deepEqual(await taskRows(), beforeReads, 'viewing unchanged tasks from two clients must not rewrite their rows')
  assert.equal(today.board.tasks.length, cases.length)
  for (const item of cases) {
    assert.equal(today.board.tasks.find(task => task.id === item.task).occurrence_title, item.expected)
    assert.equal(web.tasks.find(task => task.id === item.task).occurrence_title, item.expected)
    assert.equal(list.items.find(run => run.id === item.id).title, item.expected)
    const detail = await api.run(f.transfer, item.id)
    assert.equal(detail.run.title, item.expected); assert.equal(detail.tasks[0].occurrence_title, item.expected)
    assert.deepEqual(detail.tasks[0].assignee_ids, [f.successor])
    assert.equal((await f.db.query('select title from routine_occurrences where id=$1', [item.id])).rows[0].title, item.title)
  }
  const { filterBoardTasks } = f.load(['shared/mobile/board-view.ts'])
  assert.equal(filterBoardTasks(today.board.tasks, 'all', 'Morning routine').length, 4)
  await f.db.query("update routines set name='Updated morning' where id=$1", [template])
  const refreshed = await api.bootstrap(f.transfer)
  assert.equal(refreshed.board.tasks.find(task => task.id === cases[0].task).occurrence_title, 'Updated morning')
  assert.equal(refreshed.board.tasks.find(task => task.id === cases[3].task).occurrence_title, 'School day')
  assert.deepEqual(submittedNotifications, [])
  await f.db.query("update household_billing set paid_through=now()+interval '1 day' where household_id=$1", [f.transfer])
  await f.db.query("update occurrence_tasks set status='locked' where task_id=$1", [cases[0].task])
  await f.db.query("update tasks set expires_at=now()-interval '1 minute' where id=$1", [cases[1].task])
  const caughtUp = await api.bootstrap(f.transfer)
  assert.equal(caughtUp.board.tasks.find(task => task.id === cases[0].task).status, 'unlocked')
  assert.ok(!caughtUp.board.tasks.some(task => task.id === cases[1].task), 'the finished single-task routine leaves the active board')
  const expired = (await f.db.query('select status,completed_at,completion_reason from occurrence_tasks where task_id=$1', [cases[1].task])).rows[0]
  assert.equal(expired.status, 'completed'); assert.ok(expired.completed_at); assert.equal(expired.completion_reason, 'expiry')
  const settled = await taskRows()
  await getHouseholdMemberViewData(f.transfer, f.owner)
  assert.deepEqual(await taskRows(), settled, 'the next client sees the same transitions without writing again')
  assert.equal(submittedNotifications.length, 1, 'the real unlock still dispatches once')
  await assert.rejects(api.bootstrap(f.shared), error => error.status === 403)
})
