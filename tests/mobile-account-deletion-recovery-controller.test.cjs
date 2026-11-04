/* eslint-disable @typescript-eslint/no-require-imports -- Real SQLite/recovery journals with controlled keychain and HTTP interruptions. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes,createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),{buildSync}=require('esbuild'),root=path.resolve(__dirname,'..')
const loaded=new Module(__filename,module)
loaded._compile(buildSync({stdin:{contents:['mobile/src/storage/local-store.ts','mobile/src/storage/account-deletion-vault.ts','mobile/src/services/account-deletion-drafts.ts','mobile/src/services/account-deletion-status.ts','mobile/src/services/account-deletion-recovery.ts','mobile/src/services/account-deletion-review.ts'].map(file=>`export * from ${JSON.stringify(path.join(root,file))}`).join(';'),resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,__filename)
const {LocalStore,AccountDeletionVault,AccountDeletionDrafts,AccountDeletionStatusApi,AccountDeletionRecoveryController,parseAccountDeletionReview}=loaded.exports
class Database{
 constructor(file){this.raw=new DatabaseSync(file);this.tail=Promise.resolve();this.failSql=null}
 async execAsync(sql){this.raw.exec(sql)}
 async runAsync(sql,...args){if(this.failSql&&sql.includes(this.failSql))throw Error('Interrupted local write');return this.raw.prepare(sql).run(...args)}
 async getFirstAsync(sql,...args){return this.raw.prepare(sql).get(...args)??null}
 async getAllAsync(sql,...args){return this.raw.prepare(sql).all(...args)}
 withExclusiveTransactionAsync(work){const result=this.tail.then(async()=>{this.raw.exec('BEGIN IMMEDIATE');try{await work(this);this.raw.exec('COMMIT')}catch(e){this.raw.exec('ROLLBACK');throw e}});this.tail=result.catch(()=>{});return result}
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
async function fixture(t){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'cyntch-delete-controller-')),file=path.join(folder,'device.db'),secure=new Map(),calls=[]
 const control={failWrite:false,failRemove:false,failCleanup:false,holdCleanup:null,holdStatus:null,statusCode:200,cleanupCalls:0,
  retiredCalls:[],holdRetired:null,failRetired:new Set(),sdkProfiles:new Map()}
 const origin='https://www.cyntch.test',scope={accountId:'user_parent',sessionId:'sess_parent',deviceId:randomUUID()}
 const submission={...scope,origin,intent:{operationId:randomUUID(),revision:'a'.repeat(64),ownership:[],confirmAccountDeletion:true,acknowledgeSubscriptions:true}}
 const status={requestId:submission.intent.operationId,state:'pending',acceptedAt:'2026-11-04T01:00:00.000Z',completedAt:null,availableUntil:null,appleRevocationRequired:false}
 const storage={get:async key=>secure.get(key)??null,set:async(key,value)=>{if(control.failWrite)throw Error('Keychain unavailable');secure.set(key,value)},remove:async key=>{if(control.failRemove)throw Error('Keychain unavailable');secure.delete(key)}}
 let db,local,vault,drafts,controller
 async function restart(){
  db?.raw.close();db=new Database(file);local=new LocalStore(db);await local.initialize()
  vault=new AccountDeletionVault(storage,async()=>randomBytes(32).toString('hex'))
  drafts=new AccountDeletionDrafts(local.accountDeletion,vault,async value=>createHash('sha256').update(value).digest('hex'))
  const api=new AccountDeletionStatusApi(origin,async(url,options)=>{calls.push({url,options});await control.holdStatus?.promise;return {url,redirected:false,status:control.statusCode,headers:new Headers(),json:async()=>({...status})}})
  controller=new AccountDeletionRecoveryController(vault,drafts,api,async record=>{
   control.cleanupCalls++;assert.ok((await vault.read()).status,'Acceptance must be durable before erasure')
   await control.holdCleanup?.promise;if(control.failCleanup)throw Error('Device cleanup interrupted')
   await local.deletedAccounts.eraseAccepted(record)
  },()=>local.deletedAccounts.accounts(),async accountId=>{
   assert.equal(await local.deletedAccounts.isDeleted(accountId),true,'Only a durable deleted account can be cleaned')
   control.retiredCalls.push(accountId);await control.holdRetired?.promise
   if(control.failRetired.has(accountId))throw Error('Private SDK error: '+accountId)
   control.sdkProfiles.delete(accountId)
  })
 }
 await restart();t.after(()=>{db.raw.close();assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('cyntch-delete-controller-'));fs.rmSync(folder,{recursive:true,force:true})})
 await local.notificationSessions.activate(scope)
 for(const account of [scope.accountId,'user_other'])await db.runAsync('INSERT INTO device_settings(account_id,setting_key,data) VALUES(?,?,?)',account,'private',JSON.stringify({owner:account}))
 const saved=await drafts.prepare(submission);await drafts.requestForSubmission(saved,scope)
 return {scope,submission,status,saved,secure,calls,control,restart,get db(){return db},get local(){return local},get vault(){return vault},get drafts(){return drafts},get controller(){return controller}}
}
test('signed-out recovery fences UI before cleanup, retains receipt and survives a database restart',async t=>{
 const f=await fixture(t);await f.local.notificationSessions.close(f.scope);f.control.holdCleanup=deferred()
 const cleaning=deferred(),unsubscribe=f.controller.subscribe(()=>{if(f.controller.getSnapshot().record?.status)cleaning.resolve()})
 const request=f.controller.check();await cleaning.promise
 assert.deepEqual(f.controller.getSnapshot().deletedAccounts,[f.scope.accountId]);assert.equal(f.controller.getSnapshot().localCleanupComplete,false)
 assert.equal(f.calls[0].options.method,'GET');assert.equal(f.calls[0].options.credentials,'omit');assert.equal(f.calls[0].options.headers.Authorization,undefined)
 f.control.holdCleanup.resolve();await request;unsubscribe()
 assert.equal(f.controller.getSnapshot().localCleanupComplete,true);assert.ok((await f.vault.read()).secret)
 assert.equal(await f.local.accountDeletion.read(),null)
 assert.equal((await f.db.getAllAsync('SELECT account_id FROM device_settings')).length,1)
 await f.restart();await f.controller.refresh();assert.deepEqual(f.controller.getSnapshot().deletedAccounts,[f.scope.accountId])
 await assert.rejects(f.db.runAsync('INSERT INTO device_settings(account_id,setting_key,data) VALUES(?,?,?)',f.scope.accountId,'late','{}'),/deleted/)
 assert.equal(f.calls.length,1,'Startup resumes cleanup without automatically resending deletion or polling status')
})

test('dismissed receipts still recover a late SDK profile after restart without touching another account or calling deletion status',async t=>{
 const f=await fixture(t),complete={...f.status,state:'completed',completedAt:'2026-11-04T02:00:00.000Z',availableUntil:'2027-02-02T02:00:00.000Z'}
 await f.controller.rememberStatus(f.saved,complete);await f.controller.dismissCompleted(f.saved)
 assert.equal(await f.vault.read(),null)
 f.control.retiredCalls.length=0
 f.control.sdkProfiles.set(f.scope.accountId,{name:'Late SDK profile'});f.control.sdkProfiles.set('user_other',{name:'Other member'})
 await f.restart();await f.controller.recoverIdentity()
 assert.equal(f.controller.getSnapshot().record,null);assert.equal(f.controller.getSnapshot().localCleanupComplete,true)
 assert.deepEqual(f.control.retiredCalls,[f.scope.accountId]);assert.deepEqual([...f.control.sdkProfiles.keys()],['user_other'])
 assert.equal(f.calls.length,0,'Receipt-free recovery must not query or submit deletion')
 assert.equal((await f.db.getAllAsync('SELECT account_id FROM device_settings'))[0].account_id,'user_other')
})

test('receipt-free failures remain visible, attempt every retired identity and can recover without a receipt',async t=>{
 const f=await fixture(t),complete={...f.status,state:'completed',completedAt:'2026-11-04T02:00:00.000Z',availableUntil:'2027-02-02T02:00:00.000Z'}
 await f.controller.rememberStatus(f.saved,complete);await f.controller.dismissCompleted(f.saved)
 await f.db.runAsync('INSERT INTO native_deleted_accounts(account_id,request_id) VALUES(?,?)','user_retired',randomUUID())
 f.control.failRetired.add(f.scope.accountId);f.control.retiredCalls.length=0
 await assert.rejects(f.controller.recoverIdentity(),error=>/still need cleanup/.test(error.message)&&!error.message.includes('Private SDK'))
 assert.deepEqual(new Set(f.control.retiredCalls),new Set([f.scope.accountId,'user_retired']))
 assert.equal(f.controller.getSnapshot().localCleanupComplete,false);assert.equal(f.controller.getSnapshot().record,null)
 assert.ok(f.controller.getSnapshot().error);f.control.failRetired.clear()
 await f.controller.recoverIdentity();assert.equal(f.controller.getSnapshot().error,null);assert.equal(f.controller.getSnapshot().localCleanupComplete,true)
})

test('identity changes during a repair coalesce into one trailing pass and can repair another late callback',async t=>{
 const f=await fixture(t),complete={...f.status,state:'completed',completedAt:'2026-11-04T02:00:00.000Z',availableUntil:'2027-02-02T02:00:00.000Z'}
 await f.controller.rememberStatus(f.saved,complete);await f.controller.dismissCompleted(f.saved)
 f.control.retiredCalls.length=0;f.control.holdRetired=deferred()
 const first=f.controller.recoverIdentity()
 while(!f.control.retiredCalls.length)await new Promise(resolve=>setImmediate(resolve))
 for(let i=0;i<10;i++)assert.equal(f.controller.recoverIdentity(),first)
 f.control.holdRetired.resolve();await first
 assert.equal(f.control.retiredCalls.length,2,'Repeated lifecycle events must not create an unbounded queue')
 f.control.sdkProfiles.set(f.scope.accountId,{name:'New late callback'})
 await f.controller.recoverIdentity();assert.equal(f.control.retiredCalls.length,3)
 assert.equal(f.control.sdkProfiles.has(f.scope.accountId),false)
})
test('failed status persistence does not erase data; a later status check recovers the same request',async t=>{
 const f=await fixture(t);await f.controller.refresh();f.control.failWrite=true
 await assert.rejects(f.controller.check(),/Keychain/)
 assert.equal(f.controller.getSnapshot().record.status.state,'pending');assert.deepEqual(f.controller.getSnapshot().deletedAccounts,[f.scope.accountId])
 assert.equal(f.control.cleanupCalls,0);assert.equal((await f.db.getAllAsync('SELECT * FROM device_settings')).length,2)
 assert.equal((await f.vault.read()).status,null)
 f.control.failWrite=false;await f.restart();await f.controller.refresh();assert.equal(f.controller.getSnapshot().record.requestId,f.saved.requestId)
 await f.controller.check();assert.equal(f.controller.getSnapshot().localCleanupComplete,true)
 assert.equal(f.calls[0].options.headers['X-Cyntch-Deletion-Key'],f.calls[1].options.headers['X-Cyntch-Deletion-Key'])
})
test('receipt-first journal interruption resumes cleanup without needing another network response',async t=>{
 const f=await fixture(t);f.db.failSql='DELETE FROM native_account_deletion_intent'
 await assert.rejects(f.controller.rememberStatus(f.saved,f.status),/Interrupted/)
 assert.ok((await f.vault.read()).status);assert.ok(await f.local.accountDeletion.read());assert.equal(f.control.cleanupCalls,0)
 await f.restart();await f.controller.refresh();assert.equal(await f.local.accountDeletion.read(),null)
 assert.equal(f.controller.getSnapshot().localCleanupComplete,true);assert.equal(f.calls.length,0)
})
test('cleanup failure retains receipt and account gate; completed receipt can be removed only after cleanup',async t=>{
 const f=await fixture(t);Object.assign(f.status,{state:'completed',completedAt:'2026-11-04T02:00:00.000Z',availableUntil:'2027-02-02T02:00:00.000Z',appleRevocationRequired:true})
 f.control.failCleanup=true;await assert.rejects(f.controller.check(),/cleanup interrupted/)
 assert.equal(f.controller.getSnapshot().localCleanupComplete,false);await assert.rejects(f.controller.dismissCompleted(f.saved),/cleanup interrupted/)
 assert.equal((await f.vault.read()).status.appleRevocationRequired,true)
 f.control.failCleanup=false;await f.restart();await f.controller.refresh();await f.controller.dismissCompleted(f.saved)
 assert.equal(await f.vault.read(),null);assert.deepEqual(f.controller.getSnapshot().deletedAccounts,[f.scope.accountId]);assert.equal(f.controller.getSnapshot().record,null)
 assert.equal((await f.local.notificationSessions.activate(f.scope)).allowed,false)
 assert.equal((await f.local.notificationSessions.activate({accountId:'user_other',sessionId:'sess_other'})).allowed,true)
})
test('404 or failed checks never clear an uncertain submission or automatically retry deletion',async t=>{
 const f=await fixture(t);await f.controller.refresh();f.control.statusCode=404
 await assert.rejects(f.controller.check(),/does not confirm/);await assert.rejects(f.controller.cancelPrepared(f.saved),/may already be accepted/)
 assert.equal((await f.vault.read()).secret,f.saved.secret);assert.equal(f.control.cleanupCalls,0);assert.equal(f.calls.length,1)
 await f.restart();await f.controller.refresh();assert.equal(f.calls.length,1);assert.ok(await f.local.accountDeletion.read())
})
test('a late status reply cannot replace another request or erase its account',async t=>{
 const f=await fixture(t);f.control.holdStatus=deferred();const started=deferred()
 const original=f.calls.push.bind(f.calls);f.calls.push=(...values)=>{const result=original(...values);started.resolve();return result}
 const check=f.controller.check();await started.promise
 const withdrawal={...f.scope,requestId:f.saved.requestId,outcome:'withdrawn',withdrawnAt:'2026-11-04T01:01:00.000Z'}
 await f.drafts.rememberWithdrawal(f.saved,withdrawal,f.scope)
 const next={...f.submission,intent:{...f.submission.intent,operationId:randomUUID()}};const replacement=await f.drafts.prepare(next)
 f.control.holdStatus.resolve();await assert.rejects(check,/does not match/)
 assert.equal((await f.vault.read()).requestId,replacement.requestId);assert.equal(f.control.cleanupCalls,0)
 await f.controller.refresh();assert.equal(f.controller.getSnapshot().record.requestId,replacement.requestId)
})
test('completion and manual Apple instructions cannot regress, and contradictory receipts never reach the UI',async t=>{
 const f=await fixture(t),complete={...f.status,state:'completed',completedAt:'2026-11-04T02:00:00.000Z',availableUntil:'2027-02-02T02:00:00.000Z',appleRevocationRequired:true}
 await f.controller.rememberStatus(f.saved,complete)
 const states=[],unsubscribe=f.controller.subscribe(()=>states.push(f.controller.getSnapshot().record?.status))
 await f.controller.rememberStatus(f.saved,f.status)
 await assert.rejects(f.controller.rememberStatus(f.saved,{...f.status,acceptedAt:'2026-11-04T00:00:00.000Z'}),/does not match/)
 unsubscribe();assert.ok(states.every(status=>status?.state==='completed'&&status.appleRevocationRequired))
 assert.equal((await f.vault.read()).status.acceptedAt,complete.acceptedAt)
})
test('interrupted withdrawal cleanup resumes without erasing account data',async t=>{
 const f=await fixture(t),receipt={...f.scope,requestId:f.saved.requestId,outcome:'withdrawn',withdrawnAt:'2026-11-04T01:01:00.000Z'}
 f.control.failRemove=true;await assert.rejects(f.drafts.rememberWithdrawal(f.saved,receipt,f.scope),/Keychain/)
 assert.ok((await f.vault.read()).withdrawal);assert.equal(await f.local.accountDeletion.read(),null)
 f.control.failRemove=false;await f.restart();await f.controller.refresh()
 assert.equal(f.controller.getSnapshot().record,null);assert.equal(f.control.cleanupCalls,0);assert.equal((await f.db.getAllAsync('SELECT * FROM device_settings')).length,2)
})
test('destructive review rejects missing disclosure, impossible successors and account/session/device mismatches',()=>{
 const scope={accountId:'user_parent',sessionId:'sess_parent',deviceId:randomUUID()},review={...scope,revision:'a'.repeat(64),reviewedAt:'2026-11-04T01:00:00.000Z',authoredContent:{routines:1,runs:2,tasks:3},permanentOwnerAccess:false,
  households:[{id:randomUUID(),name:'Family',role:'manager',owned:true,ownership:{otherAccounts:1,profilesWithoutSignIn:1,possibleSuccessors:[{id:'user_successor',name:'Parent',role:'supervisor'}],content:{routines:3,runs:4,tasks:5},purchasePending:false,billing:[{provider:'stripe',environment:'unknown',status:'active',renewal:'unknown',pendingPayment:false,accessThrough:'2026-11-04 01:00:00+00',verifiedAt:null}]}}]}
 assert.deepEqual(parseAccountDeletionReview(review,scope),review)
 const mutations=[r=>{delete r.authoredContent},r=>{r.authoredContent.tasks=-1},r=>{r.authoredContent.runs=0.5},r=>{delete r.permanentOwnerAccess},r=>{r.households[0].ownership=null},r=>{r.households[0].owned=false},r=>{r.households.push(r.households[0])},r=>{r.households[0].ownership.possibleSuccessors[0].id='local_child'},r=>{r.households[0].ownership.possibleSuccessors[0].id=scope.accountId},r=>{r.households[0].ownership.possibleSuccessors[0].role='member'},r=>{delete r.households[0].ownership.billing},r=>{r.households[0].ownership.billing[0].pendingPayment='false'},r=>{r.households[0].ownership.billing[0].verifiedAt='invalid'}]
 for(const mutate of mutations){const copy=structuredClone(review);mutate(copy);assert.throws(()=>parseAccountDeletionReview(copy,scope),/incomplete/)}
 for(const key of ['accountId','sessionId','deviceId'])assert.throws(()=>parseAccountDeletionReview({...review,[key]:'other'},scope),/different/)
})
