/* eslint-disable @typescript-eslint/no-require-imports -- Real SQLite and interrupted transport tests. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite'), { buildSync } = require('esbuild'), Module = require('node:module')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const root = path.resolve(__dirname, '..')
const loaded = new Module(__filename,module)
loaded._compile(buildSync({stdin:{contents:['mobile/src/storage/local-store.ts','mobile/src/services/notification-history-controller.ts','mobile/src/storage/notification-history-store.ts','shared/mobile/notification-history.ts','shared/mobile/notification-catalog.ts','mobile/src/storage/sync-engine.ts','mobile/src/services/api.ts'].map(file=>`export * from ${JSON.stringify(path.join(root,file))}`).join(';'),resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,__filename)
const { LocalStore, NotificationHistoryController, applyHistoryAction, notificationHistoryFilterKey, notificationHistorySelections, defaultNotificationPreferences, TransportError, MobileApi } = loaded.exports
class Database {
  constructor(file) { this.db = new DatabaseSync(file); this.tail = Promise.resolve(); this.fail = false }
  async execAsync(sql) { this.db.exec(sql) }
  async runAsync(sql,...args) { if ((this.fail && sql.includes('UPDATE notification_history_cache')) || (this.failPurge && sql.includes('DELETE FROM notification_history_cache'))) throw new Error('Disk unavailable'); return this.db.prepare(sql).run(...args) }
  async getFirstAsync(sql,...args) { return this.db.prepare(sql).get(...args) ?? null }
  async getAllAsync(sql,...args) { return this.db.prepare(sql).all(...args) }
  withExclusiveTransactionAsync(work) {
    const result = this.tail.then(async () => { this.db.exec('BEGIN IMMEDIATE'); try { await work(this); this.db.exec('COMMIT') } catch(error) { this.db.exec('ROLLBACK'); throw error } })
    this.tail = result.catch(() => undefined); return result
  }
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
const point={time:'2026-11-04T00:00:00.000000Z',id:'ffffffff-ffff-ffff-ffff-ffffffffffff'}
async function fixture(t) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'cyntch-history-')),file=path.join(folder,'device.db')
  let db=new Database(file),local=new LocalStore(db);await local.initialize()
  const scope={accountId:'parent',sessionId:'sess_history',deviceId:randomUUID(),householdId:randomUUID()}
  const household={id:scope.householdId,name:'Family',role:'manager',leaderId:'parent',timezone:'Australia/Sydney'}
  await local.notificationSessions.activate(scope);await local.reconcileHouseholds('parent',[household])
  await local.cacheBoard('parent',{household,members:[{id:'parent',name:'Parent'}],tasks:[],fetchedAt:point.time})
  const preferences=defaultNotificationPreferences('parent','Australia/Sydney')
  const key=source=>notificationHistoryFilterKey(household.role,notificationHistorySelections(household.role,preferences),source)
  const item=(title='Pack bag',time='2026-11-03T20:00:00.000001Z')=>({id:randomUUID(),kind:'task_available',title,body:'A task is ready to start.',createdAt:time,read:false,occurrenceId:randomUUID(),taskId:randomUUID()})
  let page={...scope,source:'app',role:'manager',filterKey:key('app'),items:[item(),item('Feed cat')],nextCursor:null,through:point,fetchedAt:point.time}
  const calls=[],controllers=[];let allowed=true,now=1000
  const api={notificationHistory:async(hh,source,cursor)=>{calls.push(['get',hh,source,cursor]);return {...structuredClone(page),source,filterKey:key(source)}},
    updateNotificationHistory:async action=>{calls.push(['post',structuredClone(action)]);page=applyHistoryAction(page,action)}}
  let refreshAccess=async()=>{}
  const create=()=>{const c=new NotificationHistoryController(local.notificationHistory,scope,api,()=>allowed,randomUUID,()=>refreshAccess(),()=>now);controllers.push(c);c.observe(household,preferences,false);c.setVisible(true);c.setActive(true);return c}
  const controller=create();controller.setConnectivity(true);await controller.refresh()
  t.after(async()=>{controllers.forEach(c=>c.stop());await db.tail;db.db.close();const resolved=path.resolve(folder);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true})})
  return {scope,household,preferences,api,calls,item,controller,key,create,get page(){return page},setPage:value=>{page=value},setAllowed:value=>{allowed=value},advance:()=>{now+=120000},rewind:()=>{now-=600000},
    setRefresh:value=>{refreshAccess=value},get db(){return db},get local(){return local},pending:()=>local.notificationHistory.pending(scope.accountId,scope.householdId),
    reopen:async()=>{controllers.forEach(c=>c.stop());await db.tail;db.db.close();db=new Database(file);local=new LocalStore(db);await local.initialize();return create()}}
}
test('offline actions survive restart and only leave the outbox after acknowledgement',async t=>{
  const f=await fixture(t),id=f.page.items[0].id;f.controller.setConnectivity(false)
  await f.controller.change('read',id);assert.equal(f.controller.getSnapshot().page.items[0].read,true);assert.equal((await f.pending()).length,1)
  const reopened=await f.reopen();await reopened.refresh();assert.equal(reopened.getSnapshot().page.items[0].read,true)
  reopened.setConnectivity(true);await reopened.refresh();assert.equal((await f.pending()).length,0);assert.equal(f.page.items[0].read,true)
})
test('failed local commit rolls back both queue and visible history',async t=>{
  const f=await fixture(t);f.controller.setConnectivity(false);f.db.fail=true
  await assert.rejects(f.controller.change('dismiss',f.page.items[0].id),/Disk unavailable/)
  assert.equal((await f.pending()).length,0);assert.equal(f.controller.getSnapshot().page.items.length,2)
  f.db.fail=false;await f.controller.refresh();assert.equal(f.controller.getSnapshot().page.items.length,2)
})
test('lost acknowledgement replays the same action safely and preserves later events',async t=>{
  const f=await fixture(t);f.controller.setConnectivity(false);await f.controller.change('dismissAll')
  const original=f.api.updateNotificationHistory;let fail=true
  f.api.updateNotificationHistory=async action=>{await original(action);if(fail){fail=false;throw new TransportError('Lost acknowledgement',503)}}
  f.controller.setConnectivity(true);await f.controller.refresh();assert.equal((await f.pending()).length,1)
  const next=f.item('Tomorrow', '2026-11-04T01:00:00.000000Z');f.setPage({...f.page,items:[next]})
  const reopened=await f.reopen();f.advance();reopened.setConnectivity(true);await reopened.refresh()
  assert.equal((await f.pending()).length,0);assert.deepEqual(reopened.getSnapshot().page.items.map(i=>i.id),[next.id])
  const posts=f.calls.filter(c=>c[0]==='post');assert.deepEqual(posts[0][1],posts[1][1])
})
test('a slow network request cannot delay a local save or resurrect a dismissed notification',async t=>{
  const f=await fixture(t),wait=deferred(),entered=deferred(),stale=structuredClone(f.page)
  f.api.notificationHistory=async()=>{entered.resolve();await wait.promise;return stale}
  const refresh=f.controller.refresh();await entered.promise
  await f.controller.change('dismiss',stale.items[0].id)
  assert.equal(f.controller.getSnapshot().page.items.length,1);assert.equal((await f.pending()).length,1)
  wait.resolve();await refresh;assert.equal(f.controller.getSnapshot().page.items.length,1)
})
test('late pages cannot cross household, source or sign-out boundaries',async t=>{
  for(const boundary of ['household','source','signout']){
    const f=await fixture(t),wait=deferred(),entered=deferred(),page=structuredClone(f.page)
    f.api.notificationHistory=async()=>{entered.resolve();await wait.promise;return page}
    const refresh=f.controller.refresh();await entered.promise
    if(boundary==='household')f.controller.observe({...f.household,id:randomUUID()},f.preferences,false)
    else if(boundary==='source')f.controller.selectSource('web')
    else {f.setAllowed(false);f.controller.stop()}
    wait.resolve();await refresh
    if(boundary!=='signout')assert.equal(f.controller.getSnapshot().page,null)
    else assert.equal((await f.local.notificationHistory.read(f.scope,'app',f.key('app'))).items.length,2)
  }
})
test('filter changes hide old cache and reject a response from previous server preferences',async t=>{
  const f=await fixture(t),preferences=structuredClone(f.preferences);preferences.categories.task_available.enabled=false
  f.controller.observe(f.household,preferences,false);assert.equal(f.controller.getSnapshot().page,null)
  await f.controller.refresh();assert.equal(f.controller.getSnapshot().page,null);assert.match(f.controller.getSnapshot().error,/choices changed/)
  f.controller.observe(f.household,f.preferences,false);await f.controller.refresh();assert.equal(f.controller.getSnapshot().page.items.length,2)
})
test('quiet hours and push permission choices do not invalidate app history',async t=>{
  const f=await fixture(t),preferences={...f.preferences,enabled:!f.preferences.enabled,quietHours:{start:'00:00',end:'23:59'}}
  f.controller.setConnectivity(false);f.controller.observe(f.household,preferences,false);await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().page.items.length,2)
})
test('pagination retains the original bulk cutoff and overlays pending actions',async t=>{
  const f=await fixture(t);f.setPage({...f.page,nextCursor:'page-two'});await f.controller.refresh()
  const older=f.item('Older','2026-11-02T00:00:00.000001Z')
  f.api.notificationHistory=async(hh,source,cursor)=>{assert.equal(cursor,'page-two');return {...f.page,items:[f.page.items[1],older],nextCursor:null,through:{...point,time:'2026-11-04T02:00:00.000000Z'}}}
  await f.controller.loadMore();assert.equal(f.controller.getSnapshot().page.items.length,3);assert.deepEqual(f.controller.getSnapshot().page.through,point)
  f.controller.setConnectivity(false);await f.controller.change('readAll');assert.equal(f.controller.getSnapshot().page.items.every(i=>i.read),true)
})
test('kiosk and revoked session guards block persisted actions and cached reads',async t=>{
  const f=await fixture(t);f.controller.setConnectivity(false)
  await f.local.kiosk.begin({...f.scope,id:randomUUID(),state:'locked',visibleMemberIds:['parent'],editableMemberIds:['parent']})
  await assert.rejects(f.controller.change('read',f.page.items[0].id),/kiosk/)
  await assert.rejects(f.local.notificationHistory.read(f.scope,'app',f.key('app')),/kiosk/)
  assert.equal((await f.db.getAllAsync('SELECT * FROM notification_history_cache')).length,0)
  await f.db.runAsync('UPDATE native_kiosk_state SET data=NULL');await f.db.runAsync('UPDATE notification_sessions SET revoked=1')
  await assert.rejects(f.local.notificationHistory.read(f.scope,'app',f.key('app')),/Sign in again/)
})
test('membership removal and role changes remove cached history and queued actions',async t=>{
  const f=await fixture(t);f.controller.setConnectivity(false);await f.controller.change('dismiss',f.page.items[0].id)
  await f.local.reconcileHouseholds('parent',[{...f.household,role:'member'}])
  assert.equal(await f.local.notificationHistory.read(f.scope,'app',f.key('app')),null);assert.equal((await f.pending()).length,0)
  await f.local.reconcileHouseholds('parent',[]);await assert.rejects(f.local.notificationHistory.read(f.scope,'app',f.key('app')),/access/)
})
test('known server denial removes cached content before a later offline visit',async t=>{
  const f=await fixture(t);f.api.notificationHistory=async()=>{throw new TransportError('Access removed',403)}
  await f.controller.refresh();assert.equal(f.controller.getSnapshot().page,null)
  f.controller.setConnectivity(false);await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().page,null);assert.equal(await f.local.notificationHistory.read(f.scope,'app',f.key('app')),null)
})
test('a failed cache purge stays hidden until a fresh authorized read succeeds',async t=>{
  const f=await fixture(t),original=f.api.notificationHistory;f.db.failPurge=true
  f.api.notificationHistory=async()=>{throw new TransportError('Access removed',403)}
  await f.controller.refresh();f.controller.setConnectivity(false);await f.controller.refresh();assert.equal(f.controller.getSnapshot().page,null)
  f.api.notificationHistory=original;f.db.failPurge=false;f.controller.setConnectivity(true);await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().page.items.length,2)
})
test('a backwards device clock cannot strand an interrupted action in retry backoff',async t=>{
  const f=await fixture(t);f.controller.setConnectivity(false);await f.controller.change('read',f.page.items[0].id)
  const original=f.api.updateNotificationHistory;f.api.updateNotificationHistory=async()=>{throw new TransportError('Offline',503)}
  f.controller.setConnectivity(true);await f.controller.refresh();assert.equal((await f.pending()).length,1)
  f.api.updateNotificationHistory=original;f.rewind();await f.controller.refresh();assert.equal((await f.pending()).length,0)
})
test('opening waits for a current access check and rejects interrupted access',async t=>{
  const f=await fixture(t),wait=deferred(),entered=deferred();f.setRefresh(async()=>{entered.resolve();await wait.promise})
  const open=f.controller.prepareOpen(f.page.items[0].id);await entered.promise;f.setAllowed(false);wait.resolve()
  await assert.rejects(open,/access changed/);assert.equal((await f.pending()).length,0)
})
test('mobile transport rejects history and acknowledgements from a different scope',async()=>{
  const original=global.fetch,scope={accountId:'parent',sessionId:'session',deviceId:randomUUID(),householdId:randomUUID()}
  const api=new MobileApi('https://cyntch.test',scope.accountId,scope.deviceId,async()=> 'token',async()=> 'a'.repeat(64),scope.sessionId)
  try {for(const field of ['accountId','sessionId','deviceId','householdId','source']){
    global.fetch=async()=>Response.json({...scope,source:'app',[field]:'wrong'})
    await assert.rejects(api.notificationHistory(scope.householdId,'app'),/different account or device/)
    await assert.rejects(api.updateNotificationHistory({householdId:scope.householdId,source:'app',action:'read',notificationId:randomUUID()}),/different account or device/)
  }}finally{global.fetch=original}
})
