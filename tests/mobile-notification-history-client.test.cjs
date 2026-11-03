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
  const calls=[],controllers=[],households=new Map([[household.id,household]]),pages=new Map();let allowed=true,now=1000,selected=household.id
  const api={notificationHistory:async(hh,source,cursor)=>{calls.push(['get',hh,source,cursor]);return {...structuredClone(hh===household.id?page:pages.get(hh)),source,filterKey:key(source)}},
    updateNotificationHistory:async action=>{calls.push(['post',structuredClone(action)]);if(action.householdId===household.id)page=applyHistoryAction(page,action);else pages.set(action.householdId,applyHistoryAction(pages.get(action.householdId),action))}}
  let refreshAccess=async()=>{}
  const create=()=>{const c=new NotificationHistoryController(local.notificationHistory,scope,api,id=>allowed&&id===selected,randomUUID,()=>refreshAccess(),()=>now,id=>allowed&&households.has(id));controllers.push(c);c.observe(households.get(selected)??null,preferences,false);c.setVisible(true);c.setActive(true);return c}
  const controller=create();controller.setConnectivity(true);await controller.refresh()
  t.after(async()=>{controllers.forEach(c=>c.stop());await db.tail;db.db.close();const resolved=path.resolve(folder);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true})})
  return {scope,household,preferences,api,calls,item,controller,key,create,get page(){return page},setPage:value=>{page=value},setAllowed:value=>{allowed=value},advance:()=>{now+=120000},rewind:()=>{now-=600000},
    setRefresh:value=>{refreshAccess=value},get db(){return db},get local(){return local},pending:()=>local.notificationHistory.pending(scope.accountId,scope.householdId),allPending:()=>local.notificationHistory.pending(scope.accountId),
    select:(target,c=controller)=>{selected=target.id;c.observe(target,preferences,false)},
    addHousehold:async()=>{const other={...household,id:randomUUID(),name:'Other family'};households.set(other.id,other);await local.reconcileHouseholds(scope.accountId,[...households.values()]);await local.cacheBoard(scope.accountId,{household:other,members:[{id:'parent',name:'Parent'}],tasks:[],fetchedAt:point.time});const history={...page,householdId:other.id,items:[item('Other family task')]};pages.set(other.id,history);await local.notificationHistory.cache({...scope,householdId:other.id},history,key('app'));return other},
    removeHousehold:async id=>{households.delete(id);await local.reconcileHouseholds(scope.accountId,[...households.values()])},
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

async function queueTwoHouseholds(f) {
  f.controller.setConnectivity(false)
  const other=await f.addHousehold();f.select(other);await f.controller.refresh()
  const otherId=f.controller.getSnapshot().page.items[0].id
  await f.controller.change('dismiss',otherId)
  f.select(f.household);await f.controller.refresh();await f.controller.change('read',f.page.items[0].id)
  assert.equal((await f.allPending()).length,2);assert.equal(f.controller.getSnapshot().pending,2)
  f.controller.setVisible(false);f.calls.length=0
  return {other,otherId}
}
test('all households sync after restart while history is closed without opening their lists',async t=>{
  const f=await fixture(t),{other}=await queueTwoHouseholds(f),reopened=await f.reopen()
  reopened.setVisible(false);reopened.setConnectivity(true);await reopened.refresh()
  assert.equal((await f.allPending()).length,0);assert.equal(reopened.getSnapshot().pending,0)
  assert.deepEqual(f.calls.filter(c=>c[0]==='post').map(c=>c[1].householdId),[other.id,f.household.id])
  assert.equal(f.calls.some(c=>c[0]==='get'),false);assert.equal(reopened.getSnapshot().page.householdId,f.household.id)
})
test('one household can retry a lost acknowledgement while another finishes syncing',async t=>{
  const f=await fixture(t),{other}=await queueTwoHouseholds(f),original=f.api.updateNotificationHistory
  f.api.updateNotificationHistory=async action=>{await original(action);if(action.householdId===other.id)throw new TransportError('Acknowledgement lost',503)}
  f.controller.setConnectivity(true);await f.controller.refresh()
  assert.deepEqual((await f.allPending()).map(o=>o.action.householdId),[other.id]);assert.match(f.controller.getSnapshot().syncError,/Acknowledgement/)
  assert.equal(f.controller.getSnapshot().page.items[0].read,true)
  f.api.updateNotificationHistory=original;f.advance();await f.controller.refresh()
  assert.equal((await f.allPending()).length,0);assert.equal(f.controller.getSnapshot().syncError,null)
  const retried=f.calls.filter(c=>c[0]==='post'&&c[1].householdId===other.id);assert.deepEqual(retried[0],retried[1])
})
test('household denial stops its retries and clears only its cache while other households sync',async t=>{
  const f=await fixture(t),{other}=await queueTwoHouseholds(f),original=f.api.updateNotificationHistory
  let denied=0;f.api.updateNotificationHistory=async action=>{if(action.householdId===other.id){denied++;throw new TransportError('Household access removed',403,'history_household_unavailable')}await original(action)}
  f.controller.setConnectivity(true);await f.controller.refresh()
  assert.equal((await f.allPending()).length,1);assert.equal(denied,1)
  assert.equal(await f.local.notificationHistory.read({...f.scope,householdId:other.id},'app',f.key('app')),null)
  assert.equal(f.controller.getSnapshot().page.householdId,f.household.id)
  f.advance();f.controller.setVisible(true);await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal(denied,1,'A foreground history read must not resume a denied household upload')
  await f.removeHousehold(other.id);await f.controller.refresh();assert.equal((await f.allPending()).length,0)
})
test('session and kiosk rejection on one household stop all uploads and hide all account history',async t=>{
  for(const status of [401,403,423]){
    const f=await fixture(t);await queueTwoHouseholds(f);let calls=0
    f.api.updateNotificationHistory=async()=>{calls++;throw new TransportError('Access ended',status)}
    f.controller.setConnectivity(true);await f.controller.refresh()
    assert.equal(calls,1);assert.equal((await f.allPending()).length,2);assert.equal(f.controller.getSnapshot().page,null)
    assert.equal((await f.db.getAllAsync('SELECT * FROM notification_history_cache WHERE account_id=?',f.scope.accountId)).length,0)
    f.controller.setConnectivity(false);await f.controller.refresh();assert.equal(f.controller.getSnapshot().page,null)
  }
})
test('switching the visible household during an upload does not strand the other household',async t=>{
  const f=await fixture(t),{other}=await queueTwoHouseholds(f),original=f.api.updateNotificationHistory,wait=deferred(),entered=deferred()
  f.api.updateNotificationHistory=async action=>{if(action.householdId===other.id){entered.resolve();await wait.promise}await original(action)}
  f.controller.setConnectivity(true);const work=f.controller.refresh();await entered.promise
  f.select(other);wait.resolve();await work
  assert.equal((await f.allPending()).length,0);assert.equal(f.controller.getSnapshot().household.id,other.id)
  assert.notEqual(f.controller.getSnapshot().page?.householdId,f.household.id)
  assert.deepEqual(f.calls.filter(c=>c[0]==='post').map(c=>c[1].householdId),[other.id,f.household.id])
})
test('backgrounding, signing out or locking kiosk during a request prevents the next household upload',async t=>{
  for(const boundary of ['background','signout','kiosk']){
    const f=await fixture(t),{other}=await queueTwoHouseholds(f),original=f.api.updateNotificationHistory,wait=deferred(),entered=deferred()
    f.api.updateNotificationHistory=async action=>{entered.resolve();await wait.promise;await original(action)}
    f.controller.setConnectivity(true);const work=f.controller.refresh();await entered.promise
    if(boundary==='background')f.controller.setActive(false);else {
      if(boundary==='kiosk')await f.local.kiosk.begin({...f.scope,id:randomUUID(),state:'locked',visibleMemberIds:['parent'],editableMemberIds:['parent']})
      f.setAllowed(false)
    }
    wait.resolve();await work
    assert.deepEqual(f.calls.filter(c=>c[0]==='post').map(c=>c[1].householdId),[other.id]);assert.equal((await f.allPending()).length,1)
  }
})
test('a role reconciliation during an upload prevents already-enumerated stale actions from sending',async t=>{
  const f=await fixture(t);f.controller.setConnectivity(false)
  await f.controller.change('read',f.page.items[0].id);await f.controller.change('read',f.page.items[1].id)
  const original=f.api.updateNotificationHistory,wait=deferred(),entered=deferred()
  f.api.updateNotificationHistory=async action=>{entered.resolve();await wait.promise;await original(action)}
  f.controller.setConnectivity(true);const work=f.controller.refresh();await entered.promise
  await f.local.reconcileHouseholds(f.scope.accountId,[{...f.household,role:'member'}])
  f.select({...f.household,role:'member'});f.controller.setVisible(false);wait.resolve();await work
  assert.equal(f.calls.filter(c=>c[0]==='post').length,1);assert.equal((await f.allPending()).length,0)
})
test('the account-wide queue never sends another account’s saved action',async t=>{
  const f=await fixture(t);await queueTwoHouseholds(f)
  const foreign={householdId:randomUUID(),source:'app',action:'read',notificationId:randomUUID()}
  await f.db.runAsync('INSERT INTO notification_history_actions(id,account_id,household_id,data,sequence) VALUES(?,?,?,?,?)',randomUUID(),'other-account',foreign.householdId,JSON.stringify(foreign),0)
  f.controller.setConnectivity(true);await f.controller.refresh()
  assert.equal(f.calls.some(c=>c[0]==='post'&&c[1].notificationId===foreign.notificationId),false)
  assert.equal((await f.local.notificationHistory.pending('other-account')).length,1);assert.equal(f.controller.getSnapshot().pending,0)
})
