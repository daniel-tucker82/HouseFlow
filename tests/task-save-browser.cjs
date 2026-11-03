/* eslint-disable @typescript-eslint/no-require-imports -- Optional browser regression runner. */
// Run with CYNTCH_PLAYWRIGHT_PATH pointing to an installed Playwright package.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { build } = require('esbuild')
const { chromium } = require(process.env.CYNTCH_PLAYWRIGHT_PATH || 'playwright')

async function main() {
  const root = path.resolve(__dirname, '..')
  const output = path.join(root, 'node_modules/.cache/task-save-browser')
  fs.mkdirSync(output, { recursive: true })
  const hh = '41147524-744a-4565-9e9c-f1e3966596d7'
  const ids = ['b98ce792-81b7-4ceb-bbb2-1a17c8134901', 'b98ce792-81b7-4ceb-bbb2-1a17c8134902']
  const tasks = ids.map((id, i) => ({ id, household_id: hh, routine_id: hh, routine_occurrence_id: null, assignee_id: 'user-a', title: i ? 'Second task' : 'Original task', description: '', is_reward: false, status: 'locked', scheduled_time: null, position_x: 100 + i * 290, position_y: 100 }))
  const props = { currentUserId: 'user-a', households: [{ id: hh, name: 'Test household', leader_id: 'user-a', timezone: 'Australia/Sydney' }], selectedHouseholdId: hh, selectedRoutineId: hh, selectedOccurrenceId: null, routines: [{ id: hh, household_id: hh, name: 'Test routine', type: 'one_off', recurrence_rule: null, complete_older_occurrences_on_new: false }], members: [{ id: 'user-a', name: 'Alex', role: 'manager' }], tasks, allTasks: tasks, dependencies: [], invites: [], occurrences: [], occurrenceTaskStatuses: [], taskAssignees: tasks.map(task => ({ task_id: task.id, user_id: 'user-a' })), templateTaskAssignees: [], initialHideCompletedTasks: false }
  const secondRoutine = '41147524-744a-4565-9e9c-f1e3966596d8'
  const board = '41147524-744a-4565-9e9c-f1e3966596d9'
  const anotherTask = { ...tasks[0], id: 'b98ce792-81b7-4ceb-bbb2-1a17c8134903', routine_id: secondRoutine, title: 'Other routine task' }
  const boardTask = { ...tasks[0], id: 'b98ce792-81b7-4ceb-bbb2-1a17c8134904', routine_id: null, routine_occurrence_id: board, title: 'Board task', status: 'unlocked' }
  props.routines.push({ ...props.routines[0], id: secondRoutine, name: 'Another routine' })
  props.occurrences.push({ id: board, household_id: hh, routine_id: null, kind: 'manual', scheduled_for: '2026-11-03T00:00:00Z', status: 'active', title: 'Test board', total_tasks: 1, completed_tasks: 0 })
  props.allTasks = [...tasks, anotherTask, boardTask]
  const fixture = `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {TaskSaveProvider} from './components/task-save-provider';
    import {LeaderFlowEditor} from './components/leader/flow-editor';
    import {MobileRoutinePlanner} from './components/leader/mobile-routine-planner';
    import {MobileRoutineBuilder} from './demos/mobile-routine-builder/mobile-routine-builder';
    const props=${JSON.stringify(props)};
    if(location.search.includes('no-selection')){props.selectedRoutineId=null;props.selectedOccurrenceId=null}
    const root=createRoot(document.getElementById('root'));
    window.renderFixture=(patch={})=>{Object.assign(props,patch);root.render(<React.StrictMode><TaskSaveProvider>{location.pathname==='/away'?<p>Another screen</p>:location.pathname==='/demo'?<MobileRoutineBuilder/>:location.search.includes('mobile')?<MobileRoutinePlanner initial={props} onCanvas={()=>{}}/>:<LeaderFlowEditor {...props}/>}</TaskSaveProvider></React.StrictMode>)};
    window.renderFixture();`
  await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, bundle: true, outfile: path.join(output, 'app.js'), jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, plugins: [{ name: 'isolated-app-services', setup(builder) {
    builder.onResolve({ filter: /^(next\/navigation|@clerk\/nextjs|@\/lib\/actions\/leader-dashboard)$/ }, args => ({ path: args.path, namespace: 'test-services' }))
    builder.onLoad({ filter: /.*/, namespace: 'test-services' }, args => ({ loader: 'js', contents: args.path === 'next/navigation' ? 'const router={replace(){},refresh(){},push(){}}; export const useRouter=()=>router' : args.path === '@clerk/nextjs' ? 'export const useAuth=()=>({userId:"user-a"})' : 'export const saveHideCompletedTasksPreference=async()=>{}' }))
  } }] })
  const styleRoot = path.join(root, '.next/static/css')
  const styles = fs.existsSync(styleRoot) ? fs.readdirSync(styleRoot).filter(file => file.endsWith('.css')).map(file => fs.readFileSync(path.join(styleRoot, file), 'utf8')).join('\n') : ''
  let saves = 0
  let reads = 0
  let secondRoutineDelay = 0
  const server = http.createServer(async (request, response) => {
    if (request.url.startsWith('/api/leader/flow')) {
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Cache-Control', 'no-store')
      if (request.method === 'GET') {
        reads++
        const query = new URL(request.url, 'http://localhost').searchParams
        if (query.get('routineId') === secondRoutine) await new Promise(resolve => setTimeout(resolve, secondRoutineDelay))
        const selectedTasks = query.get('occurrenceId') === board ? [boardTask] : query.get('routineId') === secondRoutine ? [anotherTask] : tasks
        response.end(JSON.stringify({ ...props, tasks: selectedTasks, occurrenceTaskStatuses: query.get('occurrenceId') === board ? [{ task_id: boardTask.id, status: boardTask.status }] : [] })); return
      }
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      if (body.action === 'updateTask') {
        saves++
        await new Promise(resolve => setTimeout(resolve, 1200))
        const task = tasks.find(item => item.id === body.taskId)
        Object.assign(task, { title: body.title, description: body.notes, is_reward: body.isReward })
        response.end(JSON.stringify({ task })); return
      }
      if (body.action === 'createTask') {
        const task = { ...tasks[0], id: 'b98ce792-81b7-4ceb-bbb2-1a17c8134905', title: body.title, position_x: body.positionX, position_y: body.positionY }
        tasks.push(task); props.allTasks.push(task)
        response.end(JSON.stringify({ task })); return
      }
      if (body.action === 'setOccurrenceTaskCompleted') {
        boardTask.status = body.completed ? 'completed' : 'unlocked'
        response.end(JSON.stringify({ occurrenceTaskStatuses: [{ task_id: boardTask.id, status: boardTask.status }] })); return
      }
      response.end(JSON.stringify({})); return
    }
    if (request.url === '/app.js' || request.url === '/app.css') {
      response.setHeader('Content-Type', request.url.endsWith('.js') ? 'application/javascript' : 'text/css')
      response.end(fs.readFileSync(path.join(output, request.url.slice(1)))); return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end(`<!doctype html><html><head><style>${styles}\nhtml,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  try { browser = await chromium.launch({ executablePath: process.env.CYNTCH_CHROMIUM_PATH, headless: true }) }
  catch (error) { server.close(); throw error }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const waitFor = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('Timed out waiting for the save') }
  const openTask = async () => { await page.locator(`.react-flow__node[data-id="${ids[0]}"]`).dblclick(); await page.locator('input[name="title"]').waitFor() }
  try {
    await page.goto(origin)
    await openTask()
    await page.evaluate(id => {
      const node = document.querySelector(`.react-flow__node[data-id="${id}"]`)
      document.querySelector('input[name="title"]').addEventListener('input', () => {
        const started = performance.now()
        const observer = new MutationObserver(() => {
          if (!node.textContent.includes('Instant rename')) return
          window.renameLatency = performance.now() - started
          observer.disconnect()
        })
        observer.observe(node, { subtree: true, characterData: true, childList: true })
      }, { once: true })
    }, ids[0])
    await page.locator('input[name="title"]').fill('Instant rename')
    await page.locator(`.react-flow__node[data-id="${ids[0]}"]`).getByText('Instant rename', { exact: true }).waitFor({ timeout: 500 })
    assert.notEqual(tasks[0].title, 'Instant rename', 'UI must update before the slow server')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal(await page.locator('input[name="title"]').count(), 0)
    console.log(`Canvas title updated in ${Math.round(await page.evaluate(() => window.renameLatency))} ms with a 1,200 ms server delay; close did not wait for the save`)
    await waitFor(() => tasks[0].title === 'Instant rename')

    await openTask()
    const before = saves
    const readsBeforeEdit = reads
    await page.locator('input[name="title"]').fill('Older request')
    await waitFor(() => saves > before)
    await page.locator('input[name="title"]').fill('Latest request')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await waitFor(() => tasks[0].title === 'Older request')
    assert.equal(await page.locator(`.react-flow__node[data-id="${ids[0]}"]`).getByText('Latest request', { exact: true }).count(), 1)
    await waitFor(() => tasks[0].title === 'Latest request')
    assert.equal(reads, readsBeforeEdit, 'editing must not repeatedly reload the whole canvas')
    console.log('An older response did not revert the latest visible edit')

    await openTask()
    await page.locator('input[name="title"]').fill('Saved across navigation')
    await page.goto(origin + '/away')
    await waitFor(() => tasks[0].title === 'Saved across navigation')
    console.log('Immediate full-page navigation retained and completed the save')

    await page.goto(origin + '/?mobile')
    await page.getByRole('button', { name: /Saved across navigation/ }).first().click()
    await page.locator('#planner-task-title').fill('Mobile instant edit')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.getByRole('button', { name: /Mobile instant edit/ }).first().waitFor({ timeout: 500 })
    assert.notEqual(tasks[0].title, 'Mobile instant edit')
    await waitFor(() => tasks[0].title === 'Mobile instant edit')
    console.log('Mobile update returned to the updated routine before the server replied')

    await page.route('**/api/leader/flow', route => route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue())
    await page.getByRole('button', { name: /Mobile instant edit/ }).first().click()
    await page.locator('#planner-task-title').fill('Edit made offline')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.getByText('Changes kept on this device. Retrying the save…').waitFor()
    await page.reload()
    await page.getByRole('button', { name: /Edit made offline/ }).first().waitFor()
    assert.notEqual(tasks[0].title, 'Edit made offline')
    await page.unroute('**/api/leader/flow')
    await page.evaluate(() => window.dispatchEvent(new Event('online')))
    await waitFor(() => tasks[0].title === 'Edit made offline')
    console.log('Offline edit survived a reload, stayed visible, and saved after reconnection')
    await page.screenshot({ path: path.join(output, 'mobile-saved.png'), fullPage: true })

    await page.goto(origin)
    await openTask()
    await page.locator('input[name="title"]').fill('Focus stays put')
    await page.locator('input[name="title"]').evaluate(input => input.setSelectionRange(3, 3))
    await waitFor(() => tasks[0].title === 'Focus stays put')
    assert.deepEqual(await page.locator('input[name="title"]').evaluate(input => [document.activeElement === input, input.selectionStart]), [true, 3])
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const newNode = page.locator('.react-flow__node[data-id="b98ce792-81b7-4ceb-bbb2-1a17c8134905"]')
    await newNode.locator('.animate-pulse').waitFor()
    await newNode.locator('.animate-pulse').waitFor({ state: 'detached' })
    assert.equal(await newNode.getByText('New task', { exact: true }).count(), 1)
    console.log('Saving preserved focus and caret position; task creation retained its temporary highlight')

    secondRoutineDelay = 700
    const beforeNavigation = reads
    await page.getByRole('button', { name: 'Another routine', exact: true }).click()
    await waitFor(() => reads > beforeNavigation)
    await page.getByRole('button', { name: 'Test routine', exact: true }).click()
    await page.waitForTimeout(850)
    assert.equal(await page.locator(`.react-flow__node[data-id="${anotherTask.id}"]`).count(), 0, 'a late response must not replace the selected routine')
    secondRoutineDelay = 0
    await page.getByRole('button', { name: 'Another routine', exact: true }).click()
    await page.locator(`.react-flow__node[data-id="${anotherTask.id}"]`).waitFor()
    await page.evaluate(() => window.renderFixture({ households: [{ id: '41147524-744a-4565-9e9c-f1e3966596d7', name: 'Renamed household', leader_id: 'user-a', timezone: 'Australia/Sydney' }] }))
    await page.getByRole('option', { name: 'Renamed household' }).waitFor({ state: 'attached' })
    assert.equal(await page.locator(`.react-flow__node[data-id="${anotherTask.id}"]`).count(), 1, 'an unrelated server refresh must preserve the selected routine')
    await page.evaluate(async id => { window.renderFixture({ selectedRoutineId: id }); await new Promise(requestAnimationFrame) }, secondRoutine)
    await page.evaluate(id => window.renderFixture({ selectedRoutineId: id }), hh)
    await page.locator(`.react-flow__node[data-id="${ids[0]}"]`).waitFor()
    await page.getByRole('button', { name: /^Test board -/ }).click()
    const boardNode = page.locator(`.react-flow__node[data-id="${boardTask.id}"]`)
    await boardNode.getByRole('checkbox', { name: 'Mark task complete', exact: true }).check()
    await waitFor(() => boardTask.status === 'completed')
    await boardNode.getByRole('checkbox', { name: 'Task completed, click to mark incomplete', exact: true }).uncheck()
    await waitFor(() => boardTask.status === 'unlocked')
    await page.goto(origin + '/?no-selection')
    await page.locator(`.react-flow__node[data-id="${boardTask.id}"]`).waitFor()
    console.log('Routine navigation, server prop refreshes, stale responses, board complete/undo, and saved selection restoration all passed')

    await page.route('**/api/leader/flow?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary load failure' }) }))
    await page.goto(origin + '/?mobile')
    await page.getByRole('alert').getByText('Temporary load failure').waitFor()
    await page.unroute('**/api/leader/flow?*')
    await page.getByRole('button', { name: 'Refresh routines', exact: true }).click()
    await page.getByRole('button', { name: /Focus stays put/ }).first().waitFor()
    assert.equal(await page.getByRole('alert').count(), 0)
    console.log('Mobile routines recovered from a failed initial load using Refresh routines')

    await page.goto(origin + '/demo')
    await page.getByRole('button', { name: 'Edit routine details', exact: true }).click()
    await page.locator('#demo-routine-name').fill('My saved demo')
    await page.getByRole('button', { name: 'Save details' }).click()
    await page.reload()
    await page.getByRole('heading', { name: 'My saved demo', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Edit: Get dressed, assigned to Alex', exact: true }).click()
    await page.getByRole('button', { name: 'Remove this task', exact: true }).click()
    await page.getByRole('button', { name: 'Remove task', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Edit: Get dressed, assigned to Alex', exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await page.reload()
    await page.getByRole('button', { name: 'Edit: Get dressed, assigned to Alex', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Start from scratch', exact: true }).click()
    await page.reload()
    await page.getByRole('heading', { name: 'A fresh start.', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Reset example', exact: true }).click()
    await page.getByRole('button', { name: 'Restore sample', exact: true }).click()
    await page.reload()
    await page.getByRole('heading', { name: 'School morning', exact: true }).waitFor()
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Storage unavailable') } })
    await page.getByRole('button', { name: 'Edit routine details', exact: true }).click()
    await page.locator('#demo-routine-name').fill('Kept in memory')
    await page.getByRole('button', { name: 'Save details' }).click()
    await page.getByRole('heading', { name: 'Kept in memory', exact: true }).waitFor()
    await page.getByText('Browser storage unavailable · changes last until you leave').waitFor()
    console.log('Demo restored saved edits, persisted delete/undo and reset, and retained edits when storage was unavailable')
    assert.deepEqual(errors, [])
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.txt'), JSON.stringify({ errors, body: await page.locator('body').innerText() }, null, 2))
    throw error
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
