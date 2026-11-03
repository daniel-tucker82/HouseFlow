/* eslint-disable @typescript-eslint/no-require-imports -- Real SQLite files plus controlled OS keychain interruptions. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes,createHash}=require('node:crypto')
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild'),Module=require('node:module')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),root=path.resolve(__dirname,'..')
const loaded=new Module(__filename,module)
loaded._compile(buildSync({stdin:{contents:['mobile/src/storage/local-store.ts','mobile/src/storage/account-deletion-vault.ts','mobile/src/services/account-deletion-drafts.ts','shared/mobile/account-deletion.ts'].map(file=>`export * from ${JSON.stringify(path.join(root,file))}`).join(';'),resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,__filename)
const {LocalStore,AccountDeletionVault,AccountDeletionDrafts,normalizeAccountDeletionSubmission}=loaded.exports
const digest=async value=>createHash('sha256').update(value).digest('hex'),key='cyntch.account-deletion-recovery'
class Database{
 constructor(file){this.raw=new DatabaseSync(file);this.tail=Promise.resolve();this.failSql=null;this.loseCommit=false}
 async execAsync(sql){this.raw.exec(sql)}
 async runAsync(sql,...args){if(this.failSql&&sql.includes(this.failSql))throw new Error('Interrupted SQLite write');return this.raw.prepare(sql).run(...args)}
 async getFirstAsync(sql,...args){return this.raw.prepare(sql).get(...args)??null}
 async getAllAsync(sql,...args){return this.raw.prepare(sql).all(...args)}
 withExclusiveTransactionAsync(work){
  const result=this.tail.then(async()=>{this.raw.exec('BEGIN IMMEDIATE');try{await work(this);this.raw.exec('COMMIT')}catch(error){this.raw.exec('ROLLBACK');throw error}if(this.loseCommit)throw new Error('Lost SQLite commit acknowledgement')})
  this.tail=result.catch(()=>undefined);return result
 }
}
async function fixture(t){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'cyntch-delete-draft-')),file=path.join(folder,'device.db'),saved=new Map()
 const control={failSave:false,failBind:false,failSubmit:false,loseSubmit:false,failRemove:false,randomCalls:0}
 const storage={get:async key=>saved.get(key)??null,set:async(key,value)=>{
  const record=JSON.parse(value)
  if(control.failSave||(control.failBind&&record.intentHash)||(control.failSubmit&&record.submitted))throw new Error('Interrupted keychain write')
  saved.set(key,value);if(control.loseSubmit&&record.submitted)throw new Error('Lost keychain acknowledgement')
 },remove:async key=>{if(control.failRemove)throw new Error('Interrupted keychain removal');saved.delete(key)}}
 const random=async()=>{control.randomCalls++;return randomBytes(32).toString('hex')}
 let db,local,vault,drafts
 async function restart(){db?.raw.close();db=new Database(file);local=new LocalStore(db);await local.initialize();vault=new AccountDeletionVault(storage,random);drafts=new AccountDeletionDrafts(local.accountDeletion,vault,digest)}
 await restart()
 t.after(()=>{db.raw.close();assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('cyntch-delete-draft-'));fs.rmSync(folder,{recursive:true,force:true})})
 const scope={accountId:'user_parent',sessionId:'sess_parent',deviceId:randomUUID()}
 await local.notificationSessions.activate(scope)
 const submission={...scope,origin:'https://www.cyntch.test',intent:{operationId:randomUUID(),revision:'a'.repeat(64),ownership:[
  {householdId:randomUUID(),action:'delete'},{householdId:randomUUID(),action:'transfer',successorId:'user_successor'},
 ],confirmAccountDeletion:true,acknowledgeSubscriptions:true}}
 const status={requestId:submission.intent.operationId,state:'pending',acceptedAt:'2026-11-04T01:00:00.000Z',completedAt:null,availableUntil:null,appleRevocationRequired:false}
 return {scope,submission,status,saved,control,get db(){return db},get local(){return local},get vault(){return vault},get drafts(){return drafts},restart}
}

test('frozen deletion decisions survive a SQLite restart and retry exactly after a lost network acknowledgement',async t=>{
 const f=await fixture(t),expected=normalizeAccountDeletionSubmission(f.submission),recovery=await f.drafts.prepare(f.submission)
 assert.equal(f.control.randomCalls,1);assert.match(recovery.intentHash,/^[a-f0-9]{64}$/)
 assert.equal((await f.local.accountDeletion.read()).fingerprint,recovery.intentHash)
 const data=(await f.db.getFirstAsync('SELECT data FROM native_account_deletion_intent')).data
 assert.equal(data.includes(recovery.secret),false);assert.equal(data.includes('Authorization'),false)
 f.submission.intent.ownership=[];f.submission.intent.revision='b'.repeat(64)
 await assert.rejects(f.drafts.prepare(f.submission),/cannot be read safely/)
 await f.restart()
 const sent=[]
 async function send(){const payload=await f.drafts.requestForSubmission(recovery,f.scope);assert.equal((await f.vault.read()).submitted,true);assert.equal((await f.local.accountDeletion.read()).submitted,true);sent.push(payload);throw new Error('Lost network acknowledgement')}
 await assert.rejects(send(),/Lost network/);await f.restart();await assert.rejects(send(),/Lost network/)
 assert.deepEqual(sent[0],{...expected,recovery:{requestId:recovery.requestId,secret:recovery.secret}});assert.deepEqual(sent[1],sent[0])
 await assert.rejects(f.drafts.discardPrepared(recovery),/may already be accepted/)
})

test('preparation resumes around interrupted keychain, SQLite and hash-binding writes without rotating its key',async t=>{
 const f=await fixture(t);f.control.failSave=true
 await assert.rejects(f.drafts.prepare(f.submission),/keychain write/);assert.equal(await f.local.accountDeletion.read(),null)
 f.control.failSave=false;f.db.failSql='INSERT INTO native_account_deletion_intent'
 await assert.rejects(f.drafts.prepare(f.submission),/SQLite write/)
 const recovery=await f.vault.read();assert.equal(recovery.intentHash,null);assert.equal(await f.local.accountDeletion.read(),null)
 await f.restart();f.control.failBind=true
 await assert.rejects(f.drafts.prepare(f.submission),/keychain write/);assert.ok(await f.local.accountDeletion.read());assert.equal((await f.vault.read()).intentHash,null)
 f.control.failBind=false;await f.restart();const ready=await f.drafts.prepare(f.submission)
 assert.equal(ready.secret,recovery.secret);assert.equal(f.control.randomCalls,2)
 assert.equal((await f.drafts.requestForSubmission(ready,f.scope)).intent.operationId,recovery.requestId)
})

test('submission cannot escape before both durable writes and an interrupted SQLite marker remains recoverable',async t=>{
 const f=await fixture(t),recovery=await f.drafts.prepare(f.submission)
 f.control.failSubmit=true;await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope),/keychain write/)
 assert.equal((await f.local.accountDeletion.read()).submitted,false);assert.equal((await f.vault.read()).submitted,false)
 f.control.failSubmit=false;f.db.failSql='UPDATE native_account_deletion_intent'
 await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope),/SQLite write/)
 assert.equal((await f.vault.read()).submitted,true);assert.equal((await f.local.accountDeletion.read()).submitted,false)
 await assert.rejects(f.drafts.discardPrepared(recovery),/may already be accepted/)
 await f.restart();const payload=await f.drafts.requestForSubmission(recovery,f.scope)
 assert.equal(payload.recovery.secret,recovery.secret);assert.equal((await f.local.accountDeletion.read()).submitted,true)
})

test('lost commit and keychain acknowledgements retry the same submitted request after restart',async t=>{
 const f=await fixture(t),recovery=await f.drafts.prepare(f.submission)
 f.control.loseSubmit=true;await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope),/Lost keychain/)
 f.control.loseSubmit=false;await f.restart();f.db.loseCommit=true
 await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope),/Lost SQLite commit/)
 assert.equal((await f.local.accountDeletion.read()).submitted,true)
 await f.restart();assert.equal((await f.drafts.requestForSubmission(recovery,f.scope)).recovery.secret,recovery.secret)
})

test('concurrent conflicting preparations keep one immutable intent and one secure binding',async t=>{
 const f=await fixture(t),alternative={...f.submission,intent:{...f.submission.intent,ownership:[]}}
 const [first,second]=await Promise.allSettled([f.drafts.prepare(f.submission),f.drafts.prepare(alternative)])
 assert.equal(first.status,'fulfilled');assert.equal(second.status,'rejected')
 assert.deepEqual((await f.drafts.requestForSubmission(first.value,f.scope)).intent,normalizeAccountDeletionSubmission(f.submission).intent)
 assert.equal(f.control.randomCalls,1)
})

test('changed sign-in, device or kiosk restrictions prevent submitting the saved intent',async t=>{
 const f=await fixture(t),recovery=await f.drafts.prepare(f.submission)
 for(const scope of [{...f.scope,accountId:'user_other'},{...f.scope,sessionId:'sess_other'},{...f.scope,deviceId:randomUUID()}])await assert.rejects(f.drafts.requestForSubmission(recovery,scope),/sign-in changed/)
 await f.local.notificationSessions.activate(null)
 await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope),/sign-in changed/)
 // A corrupt device lock also fails closed, even with an otherwise matching session.
 await f.db.runAsync("UPDATE native_kiosk_state SET data='{}' WHERE id=1")
 await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope))
 assert.equal((await f.local.accountDeletion.read()).submitted,false)
 assert.equal((await f.vault.read()).submitted,true,'Keep unknown recovery; do not infer non-acceptance from a changed session')
})

test('a valid device kiosk lock blocks both preparation and submission without removing its restriction',async t=>{
 const f=await fixture(t),locked={kiosk:{...f.scope,id:randomUUID(),householdId:randomUUID(),visibleMemberIds:['child'],editableMemberIds:['child'],state:'locked'},
  activationPending:false,intent:'lock',attempts:0,nextAttemptMs:0,error:null,blocked:false,recoverySignOutSessionId:null}
 await f.db.runAsync('UPDATE native_kiosk_state SET data=? WHERE id=1',JSON.stringify(locked))
 assert.deepEqual(await f.local.kiosk.get(),locked)
 await assert.rejects(f.drafts.prepare(f.submission),/Unlock kiosk mode/);assert.equal(await f.local.accountDeletion.read(),null)
 await f.db.runAsync('UPDATE native_kiosk_state SET data=NULL WHERE id=1')
 const recovery=await f.drafts.prepare(f.submission)
 await f.db.runAsync('UPDATE native_kiosk_state SET data=? WHERE id=1',JSON.stringify(locked))
 await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope),/Unlock kiosk mode/)
 assert.deepEqual(await f.local.kiosk.get(),locked);assert.equal((await f.local.accountDeletion.read()).submitted,false)
})

test('legacy submitted recovery without an intent binding can check status but cannot silently rebuild a request',async t=>{
 const f=await fixture(t),recovery=await f.vault.prepare(f.submission.origin,f.scope.accountId,f.submission.intent.operationId)
 const legacy={...recovery,submitted:true};delete legacy.intentHash;f.saved.set(key,JSON.stringify(legacy))
 await f.restart();assert.equal((await f.vault.read()).intentHash,null)
 await assert.rejects(f.drafts.prepare(f.submission),/already submitted/)
 await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope),/does not match/)
 await assert.rejects(f.drafts.discardPrepared(recovery),/may already be accepted/)
 await f.drafts.rememberStatus(recovery,f.status)
 assert.deepEqual((await f.vault.read()).status,f.status);assert.equal(f.control.randomCalls,1)
})

test('SQLite decision corruption or a replaced key cannot submit under the original secure intent binding',async t=>{
 const f=await fixture(t),recovery=await f.drafts.prepare(f.submission),original=await f.local.accountDeletion.read()
 const altered={...original.submission,intent:{...original.submission.intent,ownership:[]}}
 await f.db.runAsync('UPDATE native_account_deletion_intent SET data=?',JSON.stringify(altered))
 await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope),/does not match/)
 assert.equal((await f.vault.read()).submitted,false)
 await f.db.runAsync('UPDATE native_account_deletion_intent SET data=?',JSON.stringify(original.submission))
 const replaced={...await f.vault.read(),secret:'b'.repeat(64)};f.saved.set(key,JSON.stringify(replaced))
 await assert.rejects(f.drafts.requestForSubmission(replaced,f.scope),/does not match/)
})

test('explicit cancellation removes only never-submitted drafts and resumes after interrupted key removal',async t=>{
 const f=await fixture(t),recovery=await f.drafts.prepare(f.submission);f.control.failRemove=true
 await assert.rejects(f.drafts.discardPrepared(recovery),/keychain removal/)
 assert.equal(await f.local.accountDeletion.read(),null);assert.equal((await f.vault.read()).submitted,false)
 await f.restart();f.control.failRemove=false;await f.drafts.discardPrepared(recovery)
 assert.equal(await f.vault.read(),null)
 await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope),/does not match/)
})

test('a submission racing local cancellation cannot lose the only recovery record',async t=>{
 const f=await fixture(t),recovery=await f.drafts.prepare(f.submission)
 const [submitted,cancelled]=await Promise.allSettled([f.drafts.requestForSubmission(recovery,f.scope),f.drafts.discardPrepared(recovery)])
 assert.equal(submitted.status,'fulfilled');assert.equal(cancelled.status,'rejected')
 assert.equal((await f.vault.read()).submitted,true);assert.equal((await f.local.accountDeletion.read()).submitted,true)
})

test('acceptance receipt is saved before removing household decisions and cleanup retries after restart',async t=>{
 const f=await fixture(t),recovery=await f.drafts.prepare(f.submission);await f.drafts.requestForSubmission(recovery,f.scope)
 f.control.failSave=true;await assert.rejects(f.drafts.rememberStatus(recovery,f.status),/keychain write/)
 assert.ok(await f.local.accountDeletion.read());assert.equal((await f.vault.read()).status,null)
 f.control.failSave=false;f.db.failSql='DELETE FROM native_account_deletion_intent'
 await assert.rejects(f.drafts.rememberStatus(recovery,f.status),/SQLite write/)
 assert.deepEqual((await f.vault.read()).status,f.status);assert.ok(await f.local.accountDeletion.read())
 await assert.rejects(f.drafts.requestForSubmission(recovery,f.scope),/already been accepted/)
 await f.restart();await f.drafts.rememberStatus(recovery,f.status)
 assert.equal(await f.local.accountDeletion.read(),null);assert.deepEqual((await f.vault.read()).status,f.status)
})

test('large household decisions stay out of the OS keychain and malformed intents do not become drafts',async t=>{
 const f=await fixture(t)
 for(const intent of [{...f.submission.intent,confirmAccountDeletion:false},{...f.submission.intent,acknowledgeSubscriptions:false},{...f.submission.intent,revision:'bad'},
  {...f.submission.intent,ownership:[f.submission.intent.ownership[0],f.submission.intent.ownership[0]]}])await assert.rejects(async()=>f.drafts.prepare({...f.submission,intent}))
 assert.equal(f.saved.size,0);assert.equal(await f.local.accountDeletion.read(),null)
 f.submission.intent.ownership=Array.from({length:100},()=>({householdId:randomUUID(),action:'transfer',successorId:'user_successor',displayName:'Do not persist this name'}))
 const recovery=await f.drafts.prepare(f.submission)
 assert.ok(f.saved.get(key).length<1024)
 const sql=(await f.db.getFirstAsync('SELECT data FROM native_account_deletion_intent')).data
 assert.ok(sql.length>2048);assert.equal(sql.includes('Do not persist this name'),false);assert.equal(sql.includes(recovery.secret),false)
})
