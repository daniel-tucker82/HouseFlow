/* eslint-disable @typescript-eslint/no-require-imports -- Real SQLite device preferences and shared board rules. */
const { test } = require('node:test'), assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite'), { randomUUID } = require('node:crypto')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module'), { buildSync } = require('esbuild')
const loaded = new Module(__filename, module)
loaded._compile(buildSync({ stdin: { contents: 'export * from "./shared/mobile/board-view"; export * from "./mobile/src/storage/local-store"', resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, __filename)
const { LocalStore, boardCompletionActor, boardDisplayAccess, defaultBoardDisplay, filterBoardTasks, orderBoardTasks, parseBoardDisplay, taskMembers } = loaded.exports
const task = (id, status = 'unlocked', extra = {}) => ({ id, occurrence_id: 'run', occurrence_title: 'Morning', occurrence_kind: 'routine', title: id,
  description: 'Task notes', is_reward: false, status, assignee_ids: ['child'], blocking_task_id: null, unlock_at: null, expires_at: null, ...extra })
function board() {
  return { household: { id: randomUUID(), name: 'Family', leaderId: 'parent', role: 'manager', timezone: 'Australia/Sydney' },
    members: [{ id: 'parent', name: 'Parent' }, { id: 'child', name: 'Alex' }, { id: 'other', name: 'Sam' }],
    tasks: [task('pack', 'unlocked', {title:'Pack BAG'}), task('reward', 'locked', {is_reward:true,blocking_task_id:'pack'}), task('done','completed'),task('unassigned','unlocked',{assignee_ids:[]})], fetchedAt: new Date().toISOString() }
}
const preferences = (visible, editable) => ({ version: 1, visibleMemberIds: visible, editableMemberIds: editable })

test('board filters combine state and title/run search without changing tasks or searching private notes', () => {
  const source=board(), before=JSON.stringify(source)
  assert.deepEqual(filterBoardTasks(source.tasks,'active','').map(t=>t.id),['pack','reward','unassigned'])
  assert.deepEqual(filterBoardTasks(source.tasks,'unlocked','  BAG ').map(t=>t.id),['pack'])
  assert.deepEqual(filterBoardTasks(source.tasks,'completed','morning').map(t=>t.id),['done'])
  assert.equal(filterBoardTasks(source.tasks,'all','task notes').length,0)
  assert.equal(filterBoardTasks(source.tasks,'all','').length,4)
  assert.equal(JSON.stringify(source),before)
})

test('board ordering matches ready/completed/locked, prerequisite depth and creation order, with occurrence isolation', () => {
  const tasks=[task('deep','locked',{blocking_task_id:'near'}),task('near','locked',{blocking_task_id:'ready'}),task('done','completed'),task('ready','unlocked'),task('time','locked')]
  assert.deepEqual(orderBoardTasks(tasks).map(t=>t.id),['ready','done','time','near','deep'])
  const sameIdOtherRun=task('deep','locked',{occurrence_id:'other-run',blocking_task_id:'near'})
  assert.deepEqual(orderBoardTasks([tasks[0],sameIdOtherRun,tasks[1]]).map(t=>t.occurrence_id+':'+t.id),['other-run:deep','run:near','run:deep'])
  assert.deepEqual(orderBoardTasks([task('new','unlocked',{created_at:'2026-11-04'}),task('old','unlocked',{created_at:'2026-11-03'})]).map(t=>t.id),['old','new'])
  const legacy=[task('new','unlocked',{created_at:'2026-11-04'}),task('legacy'),task('old','unlocked',{created_at:'2026-11-03'})]
  assert.deepEqual(orderBoardTasks(legacy).map(t=>t.id),['new','legacy','old'])
  const cycle=[task('a','locked',{blocking_task_id:'b'}),task('b','locked',{blocking_task_id:'a'})]
  assert.equal(orderBoardTasks(cycle).length,2)
  const chain=Array.from({length:1200},(_,i)=>task('t'+i,i?'locked':'unlocked',{blocking_task_id:i?'t'+(i-1):null})).reverse()
  assert.equal(orderBoardTasks(chain)[0].id,'t0'); assert.equal(orderBoardTasks(chain).at(-1).id,'t1199')
})

test('display access retains explicit empty choices and cannot grant member or kiosk permissions', () => {
  const source=board(), selected=preferences(['child'],[])
  const access=boardDisplayAccess(source,selected,'parent')
  assert.deepEqual(access,{visibleMemberIds:['child'],editableMemberIds:[]})
  assert.equal(boardCompletionActor(source,source.tasks[0],'parent',access,null),null)
  assert.deepEqual(taskMembers(source.tasks[3],'parent'),['parent'])
  const all=boardDisplayAccess(source,defaultBoardDisplay(),'parent')
  assert.equal(boardCompletionActor(source,source.tasks[3],'parent',all,'parent'),'parent')
  assert.equal(boardCompletionActor(source,source.tasks[3],'parent',all,'child'),null)
  assert.equal(boardCompletionActor(source,{...source.tasks[1],status:'unlocked'},'parent',all,null),null,'latest locked status wins over a stale row')
  source.household.role='member'
  const member=boardDisplayAccess(source,preferences(['other'],['other']),'child')
  assert.deepEqual(member.editableMemberIds,['child']); assert.equal(member.visibleMemberIds.length,3)
  assert.equal(boardCompletionActor(source,source.tasks[3],'child',all,null),null,'even a forged edit selection cannot grant a role')
  const kiosk={accountId:'parent',householdId:source.household.id,visibleMemberIds:['child'],editableMemberIds:[]}
  assert.deepEqual(boardDisplayAccess(source,defaultBoardDisplay(),'parent',kiosk).editableMemberIds,[])
  assert.equal(boardCompletionActor(source,source.tasks[0],'parent',all,null,kiosk),null)
  assert.deepEqual(boardDisplayAccess(source,defaultBoardDisplay(),'wrong-account',kiosk).visibleMemberIds,[])
  source.members=source.members.filter(m=>m.id!=='child')
  assert.deepEqual(boardDisplayAccess({...source,household:{...source.household,role:'manager'}},selected,'parent').visibleMemberIds,[],'removed selections must not mean everyone')
  assert.throws(()=>parseBoardDisplay({version:2}),/read/)
  assert.throws(()=>parseBoardDisplay({version:1,visibleMemberIds:'everyone',editableMemberIds:null}),/valid/)
})

class Database {
  constructor(file) { this.db=new DatabaseSync(file); this.tail=Promise.resolve(); this.failure=false }
  async execAsync(sql) { this.db.exec(sql) }
  async runAsync(sql,...params) { if(this.failure && sql.includes('INSERT INTO device_settings')) throw new Error('Device storage full'); return this.db.prepare(sql).run(...params) }
  async getFirstAsync(sql,...params) { return this.db.prepare(sql).get(...params)??null }
  async getAllAsync(sql,...params) { return this.db.prepare(sql).all(...params) }
  withExclusiveTransactionAsync(work) {
    const run=this.tail.then(async()=>{ this.db.exec('BEGIN IMMEDIATE'); try { await work(this); this.db.exec('COMMIT') } catch(error) { this.db.exec('ROLLBACK'); throw error } })
    this.tail=run.catch(()=>{}); return run
  }
}
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cyntch-board-view-')), file=path.join(dir,'device.db'), source=board()
  let db=new Database(file), store=new LocalStore(db); await store.initialize(); await store.cacheBoard('parent',source)
  t.after(async()=>{ await db.tail; db.db.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep)); fs.rmSync(dir,{recursive:true,force:true}) })
  return {source,get db(){return db},get store(){return store},reopen:async()=>{await db.tail;db.db.close();db=new Database(file);store=new LocalStore(db);await store.initialize()} }
}

test('device display settings survive restart, isolate accounts/households and preserve pending completions', async t => {
  const f=await fixture(t), id=f.source.household.id
  const other={...f.source,household:{...f.source.household,id:randomUUID()}}
  await f.store.cacheBoard('parent',other); await f.store.cacheBoard('another-account',f.source)
  await f.store.enqueueCompletion({id:randomUUID(),accountId:'parent',householdId:id,deviceId:randomUUID(),taskId:'pack',occurrenceId:'run',memberId:'child',completed:true,deviceTimeMs:1000})
  const pending=await f.store.pending('parent'), before=await f.store.getBoard('parent',id)
  const choice=preferences(['child'],[])
  assert.deepEqual(await f.store.saveBoardDisplay('parent',id,choice),choice)
  await f.reopen()
  assert.deepEqual(await f.store.boardDisplay('parent',id),choice)
  assert.deepEqual(await f.store.boardDisplay('another-account',id),defaultBoardDisplay())
  assert.deepEqual(await f.store.boardDisplay('parent',other.household.id),defaultBoardDisplay())
  assert.deepEqual(await f.store.pending('parent'),pending); assert.deepEqual(await f.store.getBoard('parent',id),before)
  f.db.failure=true
  await assert.rejects(f.store.saveBoardDisplay('parent',id,defaultBoardDisplay()),/storage full/)
  f.db.failure=false; await f.reopen()
  assert.deepEqual(await f.store.boardDisplay('parent',id),choice,'an interrupted save keeps the previous committed selection')
  await assert.rejects(f.store.saveBoardDisplay('parent',id,preferences(['removed'],[])),/at least one/)
})

test('kiosk activation, role loss and household removal fence display writes and remove revoked preferences', async t => {
  const f=await fixture(t), id=f.source.household.id, choice=preferences(['child'],[])
  await f.store.saveBoardDisplay('parent',id,choice)
  const kiosk={id:randomUUID(),accountId:'parent',sessionId:'sess_parent',deviceId:randomUUID(),householdId:id,visibleMemberIds:['child'],editableMemberIds:['child'],state:'locked'}
  await f.store.kiosk.begin(kiosk)
  await assert.rejects(f.store.saveBoardDisplay('parent',id,defaultBoardDisplay()),/Unlock kiosk/)
  assert.deepEqual(boardDisplayAccess(await f.store.getBoard('parent',id),choice,'parent',kiosk).editableMemberIds,['child'],'normal display preferences never replace the kiosk policy')
  await f.store.kiosk.requestUnlock(kiosk.id)
  await f.store.kiosk.acknowledge(kiosk.id,'unlock',{kiosk:{...kiosk,state:'unlocked'}})
  await f.store.cacheBoard('parent',f.source)
  await f.store.reconcileHouseholds('parent',[{...f.source.household,role:'member'}])
  await assert.rejects(f.store.saveBoardDisplay('parent',id,choice),/Parent access/)
  await f.store.reconcileHouseholds('parent',[])
  assert.equal(await f.store.setting('parent',`board-display:${id}`),null)
  await assert.rejects(f.store.saveBoardDisplay('parent',id,defaultBoardDisplay()),/Parent access/)
  assert.equal(await f.store.setting('parent',`board-display:${id}`),null,'late saves cannot recreate revoked settings')
})
