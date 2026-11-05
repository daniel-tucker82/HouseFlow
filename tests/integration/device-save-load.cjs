/* eslint-disable @typescript-eslint/no-require-imports -- Measure the real controller and a file-backed SQLite WAL in a killable process. */
const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const Module = require('node:module')
const { SqliteAdapter } = require('../helpers/mobile-sqlite.cjs')

function mobile() {
  const { buildSync } = require('esbuild')
  const source = ['storage/local-store', 'services/board-controller'].map(file =>
    'export * from ' + JSON.stringify(path.resolve(__dirname, '../../mobile/src', file + '.ts'))).join(';')
  const output = buildSync({ stdin: { contents: source, resolveDir: __dirname }, bundle: true, platform: 'node', format: 'cjs', write: false })
  const loaded = new Module(__filename, module)
  loaded._compile(output.outputFiles[0].text, __filename)
  return loaded.exports
}
const perPhase = 80
function sample(i) {
  // Each phase includes both completions and corrections, distributed across
  // the board. The second phase repeats them while the network is stalled.
  const split = i < perPhase ? 40 : 60, step = i % perPhase
  const index = ((step < split ? step : step - split) * 37) % 320
  return { index, operation: 'edit-' + (i + 1), completed: step < split }
}
function summary(samples) {
  const sorted = [...samples].sort((a,b) => a-b)
  const at = q => Math.round(sorted[Math.ceil(q * sorted.length)-1]*100)/100
  return { medianMs: at(.5), p95Ms: at(.95), maxMs: at(1) }
}

async function writer(file) {
  const { LocalStore, BoardController } = mobile()
  const disk = new SqliteAdapter(file), observer = new SqliteAdapter(file), store = new LocalStore(disk)
  await store.initialize()
  assert.equal(disk.database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(disk.database.prepare('PRAGMA synchronous').get().synchronous, 2, 'FULL synchronization')
  const members = Array.from({ length:8 }, (_,i) => ({ id:'member-'+i, name:'Member '+i }))
  const tasks = Array.from({ length:320 }, (_,i) => ({ id:'task-'+i, occurrence_id:'run-'+(i%16),
    title:'Prepare school supplies '+i, occurrence_title:'Family routine '+(i%16), occurrence_kind:'routine',
    description:'Check that everything is ready for the next school day.', is_reward:false, status:'unlocked',
    assignee_ids:[members[i%8].id], lock_type:'none', blocking_task_title:null, unlock_at:null, expires_at:null }))
  await store.cacheBoard('parent', { household:{id:'home',name:'Our home',timezone:'Australia/Sydney',leaderId:'parent',role:'manager'},
    members,tasks,fetchedAt:new Date().toISOString() })
  let bootstraps=0, clocks=0, uploads=0, sequence=0
  const stalled = new Promise(() => {})
  const board = new BoardController(store, 'parent', 'tablet', {
    bootstrap: () => { bootstraps++; return stalled }, serverTime: () => { clocks++; return stalled }, send: () => { uploads++; return stalled },
  }, () => 'edit-' + (++sequence))
  await board.start()
  const inspect = observer.database.prepare('select completed,sequence from pending_completions where id=?')
  const result = {}
  for (const [phaseIndex, phase] of ['offline','stalledNetwork'].entries()) {
    if (phaseIndex) board.setConnectivity(true)
    const stateMs=[], committedMs=[]
    for (let j=0; j<perPhase; j++) {
      const i=phaseIndex*perPhase+j, {index,operation,completed}=sample(i)
      const task=board.getSnapshot().board.tasks[index]
      assert.equal(task.id,'task-'+index)
      assert.notEqual(task.status,completed?'completed':'unlocked')
      let started, observed
      const unsubscribe=board.subscribe(() => {
        if (observed === undefined && board.getSnapshot().board.tasks[index].status===(completed?'completed':'unlocked')) observed=performance.now()-started
      })
      started=performance.now()
      const saved=await board.setCompleted(task,task.assignee_ids[0],completed)
      unsubscribe()
      assert.equal(saved,true); assert.ok(Number.isFinite(observed))
      assert.deepEqual({...inspect.get(operation)}, {completed:Number(completed),sequence:i+1})
      committedMs.push(performance.now()-started); stateMs.push(observed)
    }
    result[phase]={operations:perPhase,controllerState:summary(stateMs),committedSave:summary(committedMs)}
    assert.equal(clocks,phaseIndex); assert.equal(bootstraps,phaseIndex); assert.equal(uploads,0)
  }
  // Keep both databases open until the parent forcibly terminates this process.
  process.on('message', () => {})
  process.send(result)
}

if (process.argv[2] === '--writer') {
  writer(process.argv[3]).catch(error => { console.error(error); process.exit(1) })
} else {
  const { test } = require('node:test')
  test('task saves meet local controller/storage budgets offline and on a stalled connection, and survive process death', { timeout:45_000 }, async t => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cyntch-device-save-')), file=path.join(dir,'device.db')
    const child=fork(__filename,['--writer',file],{execArgv:[],stdio:['ignore','ignore','inherit','ipc']})
    const exited=once(child,'exit')
    t.after(async () => {
      if (child.exitCode===null && child.signalCode===null) { child.kill('SIGKILL'); await exited }
      assert.equal(path.dirname(dir),path.resolve(os.tmpdir()))
      fs.rmSync(dir,{recursive:true,force:true})
    })
    const result=await Promise.race([once(child,'message').then(([message])=>message),
      exited.then(([code,signal])=>{throw new Error('Writer exited before its save report: '+(code??signal))})])
    child.kill('SIGKILL'); await exited
    const disk=new SqliteAdapter(file)
    try {
      const {LocalStore}=mobile(), store=new LocalStore(disk)
      await store.initialize()
      const ops=await store.pending('parent'), board=await store.getBoard('parent','home')
      assert.equal(ops.length,perPhase*2); assert.equal(board.tasks.length,320)
      for (const [i,op] of ops.entries()) {
        const {index,operation,completed}=sample(i)
        assert.deepEqual([op.id,op.sequence,op.taskId,op.completed,op.correctedTimeMs,op.state],[operation,i+1,'task-'+index,completed,null,'pending'])
      }
      const expected=new Map(ops.map(op=>[op.taskId,op.completed?'completed':'unlocked']))
      for (const task of board.tasks) assert.equal(task.status,expected.get(task.id)??'unlocked')
      assert.equal(board.tasks.filter(task=>task.status==='completed').length,40)
    } finally { disk.close() }
    t.diagnostic('8 people, 16 routines, 320 tasks; milliseconds to controller state and independent SQLite read after commit. '+JSON.stringify(result))
    for(const phase of Object.values(result)) {
      assert.ok(phase.controllerState.p95Ms<=100); assert.ok(phase.committedSave.p95Ms<=250)
    }
  })
}
