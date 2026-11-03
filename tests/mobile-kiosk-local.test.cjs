/* eslint-disable @typescript-eslint/no-require-imports -- Real SQLite kiosk transactions, persistence and late-response fences. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID, randomBytes, createHash } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite'), { buildSync } = require('esbuild'), Module = require('node:module')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const root = path.resolve(__dirname, '..'), loaded = new Module(__filename, module)
loaded._compile(buildSync({ stdin: { contents: 'export * from "./mobile/src/storage/local-store"; export * from "./mobile/src/storage/kiosk-store"; export * from "./mobile/src/services/kiosk-controller"; export * from "./mobile/src/services/board-controller"; export * from "./mobile/src/storage/kiosk-pin-vault"; export * from "./mobile/src/storage/sync-engine"', resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, __filename)
const { LocalStore, nextKioskCommand, KioskController, KioskPinVault, TransportError, BoardController } = loaded.exports
class Database {
  constructor(file) { this.db = new DatabaseSync(file); this.tail = Promise.resolve(); this.failure = null }
  async execAsync(sql) { this.db.exec(sql) }
  async runAsync(sql, ...parameters) { if (this.failure && sql.includes(this.failure)) throw new Error('Disk write interrupted'); return this.db.prepare(sql).run(...parameters) }
  async getFirstAsync(sql, ...parameters) { return this.db.prepare(sql).get(...parameters) ?? null }
  async getAllAsync(sql, ...parameters) { return this.db.prepare(sql).all(...parameters) }
  withExclusiveTransactionAsync(work) {
    const pending = this.tail.then(async () => { this.db.exec('BEGIN IMMEDIATE'); try { await work(this); this.db.exec('COMMIT') } catch(error) { this.db.exec('ROLLBACK'); throw error } })
    this.tail = pending.catch(() => {}); return pending
  }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-kiosk-')), file = path.join(dir, 'device.db')
  let db = new Database(file), local = new LocalStore(db); await local.initialize()
  const householdId = randomUUID(), deviceId = randomUUID(), taskId = randomUUID(), hidden = randomUUID(), occurrenceId = randomUUID()
  const household = { id: householdId, name: 'Family', role: 'manager', leaderId: 'parent', timezone: 'Australia/Sydney' }
  const board = { household, members: [{id:'child',name:'Alex'},{id:'hidden',name:'Private member'}], fetchedAt: new Date().toISOString(),
    tasks: [{id:taskId,occurrence_id:occurrenceId,title:'Pack bag',status:'unlocked',status_version:'1',assignee_ids:['child','hidden'],blocking_task_title:'Private prerequisite',blocking_task_id:hidden,blocking_task_assignee_ids:['hidden']},
      {id:hidden,occurrence_id:occurrenceId,title:'Private task',status:'unlocked',assignee_ids:['hidden']}] }
  const kiosk = { id:randomUUID(),accountId:'parent',sessionId:'sess_parent',deviceId,householdId,visibleMemberIds:['child'],editableMemberIds:['child'],state:'locked' }
  await local.reconcileHouseholds('parent',[household]); await local.cacheBoard('parent',board)
  await local.planner.cache('parent',householdId,{householdId,routines:[],members:board.members,tasks:[],taskAssignees:[],dependencies:[],occurrences:[]})
  await local.notificationSessions.activate({accountId:'parent',sessionId:'sess_parent'})
  t.after(async () => { await db.tail; db.db.close(); const resolved = path.resolve(dir); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(resolved,{recursive:true,force:true}) })
  return { board, household, kiosk, taskId, hidden, occurrenceId, get local() {return local}, get db() {return db},
    change: (extra={}) => ({id:randomUUID(),accountId:'parent',householdId,deviceId,taskId,occurrenceId,memberId:'child',completed:true,deviceTimeMs:1000,...extra}),
    reopen: async () => { await db.tail; db.db.close(); db=new Database(file); local=new LocalStore(db); await local.initialize() } }
}
test('K02 K03 activation and restricted caches commit together, survive restart, and fence late parent responses', async t => {
  const f=await fixture(t), other={...f.board,household:{...f.household,id:randomUUID()}}
  await f.local.cacheBoard('other-account',other)
  await f.local.kiosk.begin(f.kiosk); await f.reopen()
  assert.equal(nextKioskCommand(await f.local.kiosk.get()),'activate')
  assert.deepEqual(await f.local.getBoards('other-account'),[])
  const restricted=await f.local.getBoard('parent',f.household.id)
  assert.deepEqual(restricted.members,[{id:'child',name:'Alex'}]); assert.equal(restricted.tasks.length,1)
  assert.deepEqual(restricted.tasks[0].assignee_ids,['child']); assert.equal(restricted.tasks[0].blocking_task_title,null)
  assert.equal(restricted.tasks[0].blocking_task_id,null); assert.deepEqual(restricted.tasks[0].blocking_task_assignee_ids,[])
  assert.equal(await f.local.planner.get('parent',f.household.id),null)
  await f.local.cacheBoard('parent',f.board)
  const stored=(await f.db.getFirstAsync('select data from board_snapshots')).data
  assert.ok(!stored.includes('Private')); assert.ok(!stored.includes('hidden'))
  await assert.rejects(f.local.cacheBoard('other-account',other),/Unlock kiosk/)
  await assert.rejects(f.local.planner.cache('parent',f.household.id,{householdId:f.household.id,tasks:[]}),/permission/)
  await assert.rejects(f.local.cacheRunPage('parent',{householdId:f.household.id,view:'past',items:[]}),/Unlock kiosk/)
  await assert.rejects(f.local.saveSetting('parent','keep-awake',true),/Unlock kiosk/)
  await assert.rejects(f.local.notifications.cache('parent',{accountId:'parent',deviceId:f.kiosk.deviceId,householdId:f.household.id,revision:'1',preferences:{}}),/Unlock kiosk/)
  await f.local.reconcileHouseholds('parent',[f.household,other.household])
  assert.equal(await f.local.planner.allowed('parent',f.household.id),false,'bootstrap cannot restore parent editing permission')
  assert.equal((await f.local.getBoards('parent')).length,1)
})
test('K02 O01 permitted kiosk updates remain durable offline; hidden members, read-only selections and wrong devices cannot write', async t => {
  const f=await fixture(t); await f.local.kiosk.begin(f.kiosk)
  const change=f.change(); await f.local.enqueueCompletion(change); await f.reopen()
  assert.equal((await f.local.getBoard('parent',f.household.id)).tasks[0].status,'completed')
  for(const extra of [{memberId:'hidden'},{taskId:f.hidden},{deviceId:randomUUID()},{accountId:'other'}]) await assert.rejects(f.local.enqueueCompletion(f.change(extra)))
  await f.local.acknowledge('parent',{operationId:change.id,outcome:'applied',occurrenceTaskStatuses:[{task_id:f.taskId,status:'completed',status_version:'2'},{task_id:f.hidden,status:'completed'}]})
  assert.equal((await f.local.pending('parent')).length,0)
  await f.local.kiosk.requestUnlock(f.kiosk.id)
  await f.local.kiosk.acknowledge(f.kiosk.id,'activate',{kiosk:{...f.kiosk,state:'unlocked'}})
  await f.local.cacheBoard('parent',f.board)
  const readOnly={...f.kiosk,id:randomUUID(),editableMemberIds:[]}; await f.local.kiosk.begin(readOnly)
  await assert.rejects(f.local.enqueueCompletion(f.change()),/cannot be changed/)
})
test('K02 failed activation rolls back cache pruning and never discards another account saved work or drafts', async t => {
  const f=await fixture(t)
  f.db.failure='DELETE FROM run_snapshots'
  await assert.rejects(f.local.kiosk.begin(f.kiosk),/Disk write interrupted/)
  assert.equal(await f.local.kiosk.get(),null); assert.equal((await f.local.getBoard('parent',f.household.id)).tasks.length,2)
  assert.ok(await f.local.planner.get('parent',f.household.id)); f.db.failure=null
  const edit=f.change(); await f.local.enqueueCompletion(edit)
  await assert.rejects(f.local.kiosk.begin(f.kiosk),/saved changes/)
  assert.equal((await f.local.pending('parent')).length,1)
  await f.local.acknowledge('parent',{operationId:edit.id,outcome:'applied',occurrenceTaskStatuses:[]})
  await f.local.saveSetting('other','planner-task-draft:other',{title:'Unfinished work'})
  await assert.rejects(f.local.kiosk.begin(f.kiosk),/saved routine drafts/)
  assert.equal((await f.local.setting('other','planner-task-draft:other')).title,'Unfinished work')
})
test('K02 K04 offline unlock intent survives restart; activation replies preserve newer intent and stale unlocks cannot clear a new lock', async t => {
  const f=await fixture(t); await f.local.kiosk.begin(f.kiosk)
  await f.local.kiosk.requestUnlock(f.kiosk.id); await f.reopen()
  assert.equal((await f.local.kiosk.get()).intent,'unlock')
  assert.equal(nextKioskCommand(await f.local.kiosk.get()),'unlock','cancel an unconfirmed activation directly using its original capability')
  await f.local.kiosk.acknowledge(f.kiosk.id,'activate',{kiosk:f.kiosk})
  assert.equal(nextKioskCommand(await f.local.kiosk.get()),'unlock')
  await f.local.saveSetting('parent','keep-awake',true)
  await f.local.kiosk.defer(f.kiosk.id,'unlock','Connection interrupted',1000)
  await f.reopen(); assert.equal((await f.local.kiosk.get()).nextAttemptMs,2000)
  await f.local.kiosk.acknowledge(f.kiosk.id,'unlock',{kiosk:{...f.kiosk,state:'unlocked'}})
  assert.equal(await f.local.kiosk.get(),null)
  const next={...f.kiosk,id:randomUUID()}; await f.local.kiosk.begin(next)
  assert.equal(await f.local.kiosk.acknowledge(f.kiosk.id,'unlock',{kiosk:{...f.kiosk,state:'unlocked'}}),false)
  assert.equal((await f.local.kiosk.get()).kiosk.id,next.id)
})
test('K04 only a matching authenticated recovery receipt clears a lock, including unconfirmed activation', async t => {
  const f=await fixture(t); await f.local.kiosk.begin(f.kiosk); await f.local.kiosk.requestRecovery(f.kiosk.id)
  assert.equal(nextKioskCommand(await f.local.kiosk.get()),'recover')
  await f.local.kiosk.acknowledge(f.kiosk.id,'activate',{kiosk:f.kiosk})
  assert.equal(nextKioskCommand(await f.local.kiosk.get()),'recover')
  await assert.rejects(f.local.kiosk.requestUnlock(f.kiosk.id),/parent sign-in/)
  const recovery={id:f.kiosk.id,accountId:'parent',deviceId:f.kiosk.deviceId,sessionId:f.kiosk.sessionId}
  for(const change of [{id:randomUUID()},{accountId:'other'},{deviceId:randomUUID()},{sessionId:'sess_other'}]) {
    await assert.rejects(f.local.kiosk.acknowledge(f.kiosk.id,'recover',{kiosk:null,recovery:{...recovery,...change}}),/did not match/)
  }
  await f.local.kiosk.acknowledge(f.kiosk.id,'unlock',{kiosk:{...f.kiosk,state:'unlocked'}})
  assert.equal((await f.local.kiosk.get()).intent,'recover','a late PIN unlock cannot cancel parent recovery')
  await f.local.kiosk.acknowledge(f.kiosk.id,'recover',{kiosk:null,recovery})
  assert.equal(await f.local.kiosk.get(),null)
})
test('K03 revoked parent access and corrupt local lock data remain closed', async t => {
  const f=await fixture(t); await f.local.kiosk.begin(f.kiosk)
  await f.local.reconcileHouseholds('parent',[{...f.household,role:'member'}])
  assert.equal(await f.local.getBoard('parent',f.household.id),null)
  await assert.rejects(f.local.cacheBoard('parent',f.board),/removed/)
  assert.ok(await f.local.kiosk.get())
  await f.db.runAsync("UPDATE native_kiosk_state SET data='{}' WHERE id=1")
  await assert.rejects(f.local.kiosk.get(),/could not be read safely/)
  await assert.rejects(f.local.saveSetting('parent','keep-awake',true),/could not be read safely/)
})

test('K03 only visible prerequisites in the same occurrence keep their explanation', async t => {
  const f=await fixture(t)
  const next={...f.board.tasks[0],id:randomUUID(),title:'Read a story',blocking_task_id:f.taskId,blocking_task_title:'Pack bag',blocking_task_assignee_ids:['child','hidden']}
  const otherRun={...next,id:randomUUID(),occurrence_id:randomUUID()}
  await f.local.cacheBoard('parent',{...f.board,tasks:[...f.board.tasks,next,otherRun]})
  await f.local.kiosk.begin(f.kiosk)
  const board=await f.local.getBoard('parent',f.household.id)
  assert.equal(board.tasks.find(task=>task.id===next.id).blocking_task_title,'Pack bag')
  assert.deepEqual(board.tasks.find(task=>task.id===next.id).blocking_task_assignee_ids,['child'])
  assert.equal(board.tasks.find(task=>task.id===otherRun.id).blocking_task_id,null)
  assert.equal(board.tasks.find(task=>task.id===otherRun.id).blocking_task_title,null)
})

test('K03 authoritative kiosk access denial clears cached tasks; temporary errors and late denials after unlock do not', async t => {
  const f=await fixture(t); await f.local.kiosk.begin(f.kiosk)
  let denial=new TransportError('Kiosk mode is changing',423)
  const controller=new BoardController(f.local,'parent',f.kiosk.deviceId,{bootstrap:async()=>{throw denial}},randomUUID)
  t.after(()=>controller.stop()); await controller.start(); controller.setConnectivity(true)
  await until(()=>controller.getSnapshot().error===denial.message)
  assert.ok(controller.getSnapshot().board,'an unrelated failure must preserve offline tasks')
  denial=new TransportError('Parent access to this household changed',423,'kiosk_access_changed')
  await controller.refresh()
  assert.equal(controller.getSnapshot().board,null); assert.ok(await f.local.kiosk.get())
  await assert.rejects(f.local.cacheBoard('parent',f.board),/removed/)
  await f.local.kiosk.requestUnlock(f.kiosk.id)
  await f.local.reconcileHouseholds('parent',[f.household]); await f.local.cacheBoard('parent',f.board)
  await f.local.invalidateKioskAccess('parent',f.household.id)
  assert.ok(await f.local.getBoard('parent',f.household.id),'late restricted responses cannot erase a parent cache after unlocking')
})

function runtime(f, t, api) {
  let now = 1000, controller
  const secrets = new Map(), vault = new KioskPinVault({get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value)},remove:async key=>{secrets.delete(key)}},
    {randomSecret:async()=>randomBytes(32).toString('hex'),digest:async value=>createHash('sha256').update(value).digest('hex')},()=>now)
  const identity = {accountId:'parent',sessionId:'sess_parent'}, settings = {householdId:f.household.id,visibleMemberIds:['child'],editableMemberIds:['child']}
  const start = async (online=true) => {
    controller = new KioskController(f.local.kiosk,vault,f.kiosk.deviceId,api,()=>f.kiosk.id,()=>now)
    controller.setIdentity(identity); controller.setConnectivity(online); await controller.start()
    return controller
  }
  t.after(()=>controller?.stop())
  return {vault,identity,settings,secrets,start,advance:ms=>{now+=ms},get controller(){return controller}}
}
async function until(predicate) {
  const deadline=Date.now()+3000
  while(!predicate()) { if(Date.now()>deadline) assert.fail('Timed out waiting for kiosk transition'); await new Promise(resolve=>setTimeout(resolve,2)) }
}
test('K02 controller replays a lost activation reply and syncs a durable offline PIN unlock after restart', async t => {
  const f=await fixture(t), sent=[]; let first=true
  const r=runtime(f,t,()=>({saveKiosk:async operation=>{
    sent.push(operation)
    if(first){first=false;throw new TransportError('Reply lost',503)}
    return {kiosk:{...f.kiosk,state:operation.action==='unlock'?'unlocked':'locked'}}
  }}))
  await r.start(); await r.controller.activate(r.settings,'810426')
  await until(()=>r.controller.getSnapshot().record?.error==='Reply lost')
  r.controller.stop(); await f.reopen(); r.advance(2000); await r.start()
  await until(()=>r.controller.getSnapshot().record?.activationPending===false)
  assert.equal(sent.length,2); assert.deepEqual(sent[0],sent[1],'retries preserve the original ID, configuration and protected exit key')
  r.controller.setConnectivity(false)
  await r.controller.unlock('810426'); assert.equal((await f.local.kiosk.get()).intent,'unlock')
  assert.equal(sent.length,2,'offline unlocking never waits for a server')
  r.controller.stop(); await f.reopen(); await r.start(false)
  assert.equal(r.controller.getSnapshot().record.intent,'unlock')
  r.controller.setConnectivity(true)
  await until(()=>r.controller.getSnapshot().record===null)
  assert.equal(sent.at(-1).action,'unlock'); assert.equal(r.secrets.size,0)
})
test('K04 newer PIN unlock intent survives an in-flight activation response', async t => {
  const f=await fixture(t), sent=[]; let release
  const r=runtime(f,t,()=>({saveKiosk:async operation=>{
    sent.push(operation)
    if(operation.action==='activate') await new Promise(resolve=>{release=resolve})
    return {kiosk:{...f.kiosk,state:operation.action==='unlock'?'unlocked':'locked'}}
  }}))
  await r.start(); await r.controller.activate(r.settings,'810426'); await until(()=>Boolean(release))
  await r.controller.unlock('810426')
  assert.equal((await f.local.kiosk.get()).intent,'unlock')
  release(); await until(()=>r.controller.getSnapshot().record===null)
  assert.deepEqual(sent.map(operation=>operation.action),['activate','unlock'])
})
test('K04 forgotten-PIN recovery waits for the same parent under a different session and works without a local credential', async t => {
  const f=await fixture(t), sent=[]
  const r=runtime(f,t,identity=>({saveKiosk:async operation=>{
    sent.push({identity,operation})
    if(operation.action==='activate') return {kiosk:f.kiosk}
    return {kiosk:null,recovery:{id:f.kiosk.id,accountId:'parent',deviceId:f.kiosk.deviceId,sessionId:'sess_parent'}}
  }}))
  await r.start(); await r.controller.activate(r.settings,'810426')
  await until(()=>r.controller.getSnapshot().record?.activationPending===false)
  await r.vault.remove(f.kiosk.id)
  r.controller.setIdentity({accountId:'parent',sessionId:'sess_already_signed_in'})
  await r.controller.beginRecovery()
  assert.equal((await f.local.kiosk.get()).recoverySignOutSessionId,'sess_already_signed_in')
  r.controller.stop(); await f.reopen(); await r.start()
  assert.equal((await f.local.kiosk.get()).recoverySignOutSessionId,'sess_already_signed_in')
  assert.equal(sent.length,1,'a different session present before recovery is not fresh parent verification')
  r.controller.setIdentity(null); r.controller.setIdentity({accountId:'child',sessionId:'sess_child'})
  assert.equal(sent.length,1)
  r.controller.setIdentity({accountId:'parent',sessionId:'sess_parent'}); assert.equal(sent.length,1)
  r.controller.setIdentity({accountId:'parent',sessionId:'sess_reauthenticated'})
  await until(()=>r.controller.getSnapshot().record===null)
  assert.equal(sent[1].operation.action,'recover'); assert.equal(sent[1].operation.previousSessionId,'sess_parent')
  assert.equal(sent[1].operation.exitSecret,undefined,'parent reauthentication does not depend on the forgotten PIN credential')
})
test('K04 rejected activation stays protected without repeated requests and a verified PIN can cancel it', async t => {
  const f=await fixture(t), sent=[]
  const r=runtime(f,t,()=>({saveKiosk:async operation=>{
    sent.push(operation)
    if(operation.action==='activate') throw new TransportError('Selected member was removed',409)
    return {kiosk:null,cancelledActivation:{id:f.kiosk.id,accountId:'parent',deviceId:f.kiosk.deviceId,sessionId:'sess_parent'}}
  }}))
  await r.start(); await r.controller.activate(r.settings,'810426')
  await until(()=>r.controller.getSnapshot().record?.blocked)
  r.controller.stop(); await f.reopen(); r.advance(60000); await r.start()
  r.controller.setConnectivity(true); r.controller.setActive(true); assert.equal(sent.length,1)
  await assert.rejects(r.controller.unlock('000000'),/did not match/)
  assert.equal((await f.local.kiosk.get()).intent,'lock')
  await r.controller.unlock('810426'); await until(()=>r.controller.getSnapshot().record===null)
  assert.equal(sent[1].action,'unlock')
})
test('K02 controller activation failure preserves pending work and cleans only its unused PIN credential', async t => {
  const f=await fixture(t), r=runtime(f,t,()=>({saveKiosk:async()=>assert.fail('No server request before durable activation')}))
  const edit=f.change(); await f.local.enqueueCompletion(edit)
  await r.start(); await assert.rejects(r.controller.activate(r.settings,'810426'),/saved changes/)
  assert.equal(r.controller.getSnapshot().ready,true); assert.equal(r.controller.getSnapshot().record,null)
  assert.equal(r.secrets.size,0); assert.equal((await f.local.pending('parent'))[0].id,edit.id)
})
