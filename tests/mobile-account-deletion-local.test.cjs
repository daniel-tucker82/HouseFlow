/* eslint-disable @typescript-eslint/no-require-imports -- Real SQLite deletion, restart and late-write isolation. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),{buildSync}=require('esbuild'),root=path.resolve(__dirname,'..')
const loaded=new Module(__filename,module)
loaded._compile(buildSync({stdin:{contents:'export * from "./mobile/src/storage/local-store.ts";export * from "./mobile/src/storage/account-deletion-local.ts";',resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,__filename)
const {LocalStore,deletionAccountTables}=loaded.exports
class Database{
 constructor(file){this.raw=new DatabaseSync(file);this.tail=Promise.resolve();this.failSql=null;this.loseCommit=false}
 async execAsync(sql){this.raw.exec(sql)}
 async runAsync(sql,...args){if(this.failSql&&sql.includes(this.failSql))throw Error('Interrupted cleanup');return this.raw.prepare(sql).run(...args)}
 async getFirstAsync(sql,...args){return this.raw.prepare(sql).get(...args)??null}
 async getAllAsync(sql,...args){return this.raw.prepare(sql).all(...args)}
 withExclusiveTransactionAsync(work){const result=this.tail.then(async()=>{this.raw.exec('BEGIN IMMEDIATE');try{await work(this);this.raw.exec('COMMIT')}catch(e){this.raw.exec('ROLLBACK');throw e}if(this.loseCommit)throw Error('Lost cleanup acknowledgement')});this.tail=result.catch(()=>{});return result}
}
async function fixture(t){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'cyntch-delete-local-')),file=path.join(folder,'device.db');let db,local
 async function restart(){db?.raw.close();db=new Database(file);local=new LocalStore(db);await local.initialize()}
 await restart();t.after(()=>{db.raw.close();assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('cyntch-delete-local-'));fs.rmSync(folder,{recursive:true,force:true})})
 const accountId='user_delete',other='user_other',requestId=randomUUID(),kioskId=randomUUID()
 const record={format:1,origin:'https://www.cyntch.test',accountId,requestId,secret:randomBytes(32).toString('hex'),submitted:true,intentHash:'a'.repeat(64),withdrawal:null,
  status:{requestId,state:'pending',acceptedAt:'2026-11-04T01:00:00.000Z',completedAt:null,availableUntil:null,appleRevocationRequired:false}}
 const rows=new Map()
 for(const table of deletionAccountTables){
  const columns=db.raw.prepare(`PRAGMA table_info(${table})`).all()
  for(const account of [accountId,other]){
   const values=columns.map(column=>column.name==='account_id'?account:column.name==='revoked'?(account===accountId?0:1):column.type==='INTEGER'?1:column.name==='data'||column.name==='body'?'{}':account+'-'+column.name)
   const sql=`INSERT INTO ${table}(${columns.map(c=>c.name).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`
   await db.runAsync(sql,...values);rows.set(table+account,{sql,values})
  }
 }
 await db.runAsync("UPDATE native_kiosk_state SET data=? WHERE id=1",JSON.stringify({kiosk:{id:kioskId,accountId}}))
 return {get db(){return db},get local(){return local},record,accountId,other,kioskId,rows,restart}
}
test('accepted cleanup erases every account cache atomically, retains other accounts and survives restart',async t=>{
 const f=await fixture(t)
 const scoped=f.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().filter(row=>f.db.raw.prepare(`PRAGMA table_info(${row.name})`).all().some(column=>column.name==='account_id')).map(row=>row.name).sort()
 assert.deepEqual(scoped,[...deletionAccountTables,'native_deleted_accounts'].sort(),'New account storage must join the erasure inventory')
 const otherBefore=Object.fromEntries(deletionAccountTables.map(table=>[table,f.db.raw.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(f.other)]))
 const cleanupBefore=await f.local.notificationSessions.cleanupVersion()
 await f.local.deletedAccounts.eraseAccepted(f.record)
 assert.equal(await f.local.deletedAccounts.isDeleted(f.accountId),true);assert.equal(await f.local.deletedAccounts.isDeleted(f.other),false)
 for(const table of deletionAccountTables){assert.equal(f.db.raw.prepare(`SELECT count(*) n FROM ${table} WHERE account_id=?`).get(f.accountId).n,0);assert.deepEqual(f.db.raw.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(f.other),otherBefore[table])}
 assert.equal(await f.local.kiosk.get(),null);assert.deepEqual(await f.local.deletedAccounts.pendingKioskKeys(f.accountId),[f.kioskId])
 assert.notEqual(await f.local.notificationSessions.cleanupVersion(),cleanupBefore)
 const marker=f.db.raw.prepare('SELECT * FROM native_deleted_accounts').get();assert.equal(JSON.stringify(marker).includes(f.record.secret),false)
 await f.restart();assert.equal(await f.local.deletedAccounts.isDeleted(f.accountId),true)
 await f.local.deletedAccounts.eraseAccepted(f.record);assert.deepEqual(await f.local.deletedAccounts.pendingKioskKeys(f.accountId),[f.kioskId])
 await f.local.deletedAccounts.acknowledgeKioskKey(f.accountId,f.record.requestId,f.kioskId);assert.deepEqual(await f.local.deletedAccounts.pendingKioskKeys(f.accountId),[])
 assert.equal(await f.local.deletedAccounts.isDeleted(f.accountId),true)
})
test('database fences reject late inserts and account reassignment across every cache, session and kiosk',async t=>{
 const f=await fixture(t);await f.local.deletedAccounts.eraseAccepted(f.record);await f.restart()
 for(const table of deletionAccountTables){
  const row=f.rows.get(table+f.accountId);await assert.rejects(f.db.runAsync(row.sql,...row.values),/account has been deleted/)
  await assert.rejects(f.db.runAsync(`UPDATE ${table} SET account_id=? WHERE account_id=?`,f.accountId,f.other),/account has been deleted/)
 }
 await assert.rejects(f.local.saveSetting(f.accountId,'selected-household','stale'),/account has been deleted/)
 await assert.rejects(f.db.runAsync('UPDATE native_kiosk_state SET data=? WHERE id=1',JSON.stringify({kiosk:{id:f.kioskId,accountId:f.accountId}})),/account has been deleted/)
 assert.equal((await f.local.notificationSessions.activate({accountId:f.accountId,sessionId:'sess_new'})).allowed,false)
 await f.local.notificationSessions.close({accountId:f.accountId,sessionId:'sess_old'});assert.equal(await f.local.notificationSessions.active(),null)
})
test('cleanup interruptions roll back both data and fence; lost commit acknowledgement safely replays',async t=>{
 const f=await fixture(t);f.db.failSql='DELETE FROM planner_snapshots'
 await assert.rejects(f.local.deletedAccounts.eraseAccepted(f.record),/Interrupted cleanup/)
 assert.equal(await f.local.deletedAccounts.isDeleted(f.accountId),false)
 for(const table of deletionAccountTables)assert.equal(f.db.raw.prepare(`SELECT count(*) n FROM ${table} WHERE account_id=?`).get(f.accountId).n,1)
 await f.restart();f.db.loseCommit=true;await assert.rejects(f.local.deletedAccounts.eraseAccepted(f.record),/Lost cleanup/)
 await f.restart();assert.equal(await f.local.deletedAccounts.isDeleted(f.accountId),true);await f.local.deletedAccounts.eraseAccepted(f.record)
 for(const table of deletionAccountTables)assert.equal(f.db.raw.prepare(`SELECT count(*) n FROM ${table} WHERE account_id=?`).get(f.accountId).n,0)
})
test('unconfirmed, withdrawn or mismatched receipts cannot erase data or replace a retained fence',async t=>{
 const f=await fixture(t)
 for(const patch of [{submitted:false},{status:null},{withdrawal:{outcome:'withdrawn'}},{status:{...f.record.status,requestId:randomUUID()}}])await assert.rejects(f.local.deletedAccounts.eraseAccepted({...f.record,...patch}))
 assert.equal(await f.local.deletedAccounts.isDeleted(f.accountId),false)
 await f.local.deletedAccounts.eraseAccepted(f.record)
 const requestId=randomUUID();await assert.rejects(f.local.deletedAccounts.eraseAccepted({...f.record,requestId,status:{...f.record.status,requestId}}),/does not match/)
})
test('deleting an inactive account preserves the active household notification session and its device lock',async t=>{
 const f=await fixture(t)
 await f.db.runAsync('UPDATE notification_sessions SET revoked=1 WHERE account_id=?',f.accountId)
 await f.db.runAsync('UPDATE notification_sessions SET revoked=0 WHERE account_id=?',f.other)
 const lock=JSON.stringify({kiosk:{id:randomUUID(),accountId:f.other}});await f.db.runAsync('UPDATE native_kiosk_state SET data=? WHERE id=1',lock)
 const before=await f.local.notificationSessions.cleanupVersion();await f.local.deletedAccounts.eraseAccepted(f.record)
 assert.equal((await f.local.notificationSessions.active()).accountId,f.other);assert.equal(await f.local.notificationSessions.cleanupVersion(),before)
 assert.equal(f.db.raw.prepare('SELECT data FROM native_kiosk_state').get().data,lock)
 assert.deepEqual(await f.local.deletedAccounts.pendingKioskKeys(f.accountId),[])
})
