/* eslint-disable @typescript-eslint/no-require-imports -- Real SQLite journals with controlled native identity interruptions. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes,createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),{buildSync}=require('esbuild'),root=path.resolve(__dirname,'..')
function load(files,mocks={}){const loaded=new Module(__filename,module);loaded.require=name=>mocks[name]??require(name);loaded._compile(buildSync({stdin:{contents:files.map(file=>`export * from ${JSON.stringify(path.join(root,file))}`).join(';'),resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,define:{__DEV__:'true'},supported:{'dynamic-import':false},external:Object.keys(mocks)}).outputFiles[0].text,__filename);return loaded.exports}
const {LocalStore,BillingIdentityController,waitForBillingIdentityCleanup}=load(['mobile/src/storage/local-store.ts','mobile/src/services/billing-identity.ts'])
class Database{
 constructor(file){this.raw=new DatabaseSync(file);this.tail=Promise.resolve();this.failIdentity=false}
 async execAsync(sql){this.raw.exec(sql)}
 async runAsync(sql,...args){if(this.failIdentity&&sql.includes('UPDATE native_billing_identity'))throw Error('Interrupted identity journal');return this.raw.prepare(sql).run(...args)}
 async getFirstAsync(sql,...args){return this.raw.prepare(sql).get(...args)??null}
 async getAllAsync(sql,...args){return this.raw.prepare(sql).all(...args)}
 withExclusiveTransactionAsync(work){const result=this.tail.then(async()=>{this.raw.exec('BEGIN IMMEDIATE');try{await work(this);this.raw.exec('COMMIT')}catch(error){this.raw.exec('ROLLBACK');throw error}});this.tail=result.catch(()=>{});return result}
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
async function fixture(t){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'cyntch-billing-identity-')),file=path.join(folder,'device.db'),calls=[],cache=new Set()
 const native={configured:false,user:null,configuration:null},faults={configureAfter:false,loginBefore:false,loginAfter:false,logoutAfter:false,settleAfterLogin:false,settleAfterLogout:false}
 const a={accountId:'user_a',sessionId:'sess_a',deviceId:randomUUID(),householdId:randomUUID(),billingCustomerId:randomUUID(),publicSdkKey:'appl_fixture',store:'app_store',environment:'sandbox'}
 const b={...a,accountId:'user_b',sessionId:'sess_b',householdId:randomUUID(),billingCustomerId:randomUUID()}
 let db,local,controller
 const driver={
  isConfigured:async()=>native.configured,current:async()=>{assert.equal(native.configured,true);return native.user},isAnonymous:async()=>native.user?.startsWith('$RCAnonymousID:')===true,
  configure:async(identity,resume)=>{
   const journal=await local.billingIdentity.read();assert.ok(journal.current||journal.pending,'Journal must commit before configure')
   calls.push(['configure',identity.billingCustomerId,resume])
   const configuration=resume?null:identity.billingCustomerId
   if(native.configured&&native.configuration===configuration)return
   native.configured=true;native.configuration=configuration;native.user=resume?(native.user??'$RCAnonymousID:'+randomBytes(16).toString('hex')):identity.billingCustomerId;cache.add(native.user)
   if(faults.configureAfter)throw Error('Lost configure acknowledgement')
  },
  logIn:async id=>{
   assert.equal((await local.billingIdentity.read()).pending.billingCustomerId,id);calls.push(['login',id])
   if(faults.loginBefore)throw Error('Login unavailable')
   cache.delete(native.user);native.user=id;cache.add(id)
   if(faults.settleAfterLogin)db.failIdentity=true
   if(faults.loginAfter)throw Error('Lost login acknowledgement')
  },
  logOut:async()=>{
   calls.push(['logout',native.user]);cache.delete(native.user);native.user='$RCAnonymousID:'+randomBytes(16).toString('hex');cache.add(native.user)
   if(faults.settleAfterLogout)db.failIdentity=true
   if(faults.logoutAfter)throw Error('Lost logout acknowledgement')
  },
 }
 async function restart(){db?.raw.close();db=new Database(file);local=new LocalStore(db);await local.initialize();native.configured=false;controller=new BillingIdentityController(local.billingIdentity,driver)}
 await restart();await local.notificationSessions.activate(a)
 t.after(()=>{db.raw.close();assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('cyntch-billing-identity-'));fs.rmSync(folder,{recursive:true,force:true})})
 async function erase(identity=a){const requestId=randomUUID();await local.deletedAccounts.eraseAccepted({format:1,origin:'https://www.cyntch.test',accountId:identity.accountId,requestId,secret:randomBytes(32).toString('hex'),submitted:true,intentHash:null,withdrawal:null,
  status:{requestId,state:'pending',acceptedAt:'2026-11-04T01:00:00.000Z',completedAt:null,availableUntil:null,appleRevocationRequired:false}})}
 return {a,b,calls,cache,native,faults,driver,restart,erase,get db(){return db},get local(){return local},get controller(){return controller},run:(identity=a,work=async()=>{})=>controller.run(identity,()=>{},work),activate:identity=>local.notificationSessions.activate(identity)}
}
test('identity is durable before native configure/login; journal failure cannot configure the SDK',async t=>{
 const f=await fixture(t);f.db.failIdentity=true
 await assert.rejects(f.run(),/journal/);assert.deepEqual(f.calls,[]);assert.equal(f.native.configured,false)
 f.db.failIdentity=false;await f.run();assert.deepEqual((await f.local.billingIdentity.read()).current,f.a)
 await f.activate(f.b);await f.run(f.b);assert.equal(f.native.user,f.b.billingCustomerId);assert.equal(f.cache.has(f.a.billingCustomerId),false)
 const raw=(await f.db.getFirstAsync('SELECT data FROM native_billing_identity')).data
 assert.equal(raw.includes('products'),false);assert.equal(raw.includes('receipt'),false);assert.equal(raw.includes('token'),false)
})
test('cold-start cleanup restores the tracked SDK identity and logs out before clearing the journal',async t=>{
 const f=await fixture(t);await f.run();await f.erase();await f.restart()
 assert.equal((await f.local.billingIdentity.read()).current.accountId,f.a.accountId,'Ordinary account erasure must retain SDK ownership')
 await f.controller.eraseDeletedAccount(f.a.accountId)
 assert.equal(f.cache.has(f.a.billingCustomerId),false);assert.ok(f.native.user.startsWith('$RCAnonymousID:'))
 assert.equal((await f.local.billingIdentity.read()).current,null);assert.deepEqual(f.calls.map(c=>c[0]),['configure','configure','logout'])
 await assert.rejects(f.run(),/deleted/)
})
test('an unaccepted deletion cannot clear SDK identity, while unused billing requires no SDK initialization',async t=>{
 const f=await fixture(t);await assert.rejects(f.controller.eraseDeletedAccount(f.a.accountId),/Confirm account/)
 await f.erase();await f.controller.eraseDeletedAccount(f.a.accountId);assert.deepEqual(f.calls,[]);assert.equal(f.native.configured,false)
})
test('logout waits for an in-flight purchase and a timed-out cleanup never releases the SDK queue',async t=>{
 const f=await fixture(t),entered=deferred(),finish=deferred();let later=false
 const buying=f.run(f.a,async guard=>{entered.resolve();await finish.promise;guard()});const rejected=assert.rejects(buying,/deleted/)
 await entered.promise;await f.erase()
 const cleanup=f.controller.eraseDeletedAccount(f.a.accountId)
 await assert.rejects(waitForBillingIdentityCleanup(cleanup,15),/cleanup needs/)
 await f.activate(f.b);const next=f.run(f.b,async()=>{later=true})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(later,false);assert.equal(f.calls.some(c=>c[0]==='logout'),false)
 finish.resolve();await rejected;await cleanup;await next
 assert.equal(f.native.user,f.b.billingCustomerId);assert.deepEqual(f.calls.map(c=>c[0]),['configure','logout','configure','configure'])
 assert.equal((await f.local.billingIdentity.read()).current.accountId,f.b.accountId)
})
test('a completed operation cannot reuse a captured native callback after another household starts',async t=>{
 const f=await fixture(t);let savedGuard
 await f.run(f.a,async guard=>{savedGuard=guard});await f.activate(f.b);await f.run(f.b)
 assert.throws(savedGuard,/operation has ended/);assert.equal(f.native.user,f.b.billingCustomerId)
})
test('late cleanup preserves a newer account and never logs that account out',async t=>{
 const f=await fixture(t);await f.run();await f.activate(f.b);await f.run(f.b);await f.erase(f.a)
 await f.controller.eraseDeletedAccount(f.a.accountId)
 assert.equal(f.native.user,f.b.billingCustomerId);assert.equal(f.calls.some(c=>c[0]==='logout'),false)
 assert.equal((await f.local.billingIdentity.read()).current.accountId,f.b.accountId)
})
test('lost login acknowledgement is resolved using native identity without logging out the newer account',async t=>{
 const f=await fixture(t);await f.run();await f.activate(f.b);f.faults.loginAfter=true
 await assert.rejects(f.run(f.b),/Lost login/);let state=await f.local.billingIdentity.read();assert.equal(state.current.accountId,f.a.accountId);assert.equal(state.pending.accountId,f.b.accountId)
 await f.erase(f.a);await f.restart();await f.controller.eraseDeletedAccount(f.a.accountId)
 state=await f.local.billingIdentity.read();assert.equal(state.current.accountId,f.b.accountId);assert.equal(state.pending,null)
 assert.equal(f.calls.some(c=>c[0]==='logout'),false);assert.equal(f.native.user,f.b.billingCustomerId)
})
test('an unsuccessful pending login cannot make deletion of that account log out the prior account',async t=>{
 const f=await fixture(t);await f.run();await f.activate(f.b);f.faults.loginBefore=true
 await assert.rejects(f.run(f.b),/Login unavailable/);await f.erase(f.b);await f.restart();await f.controller.eraseDeletedAccount(f.b.accountId)
 assert.equal(f.native.user,f.a.billingCustomerId);assert.equal((await f.local.billingIdentity.read()).current.accountId,f.a.accountId)
 assert.equal(f.calls.some(c=>c[0]==='logout'),false)
})
test('interruption after logout or journal acknowledgement resumes without logging out twice',async t=>{
 for(const fault of ['logoutAfter','settleAfterLogout']){
  const f=await fixture(t);await f.run();await f.erase();f.faults[fault]=true
  await assert.rejects(f.controller.eraseDeletedAccount(f.a.accountId),/Lost logout|journal/)
  assert.ok((await f.local.billingIdentity.read()).current);assert.equal(f.cache.has(f.a.billingCustomerId),false)
  await f.restart();await f.controller.eraseDeletedAccount(f.a.accountId)
  assert.equal((await f.local.billingIdentity.read()).current,null);assert.equal(f.calls.filter(c=>c[0]==='logout').length,1)
 }
})
test('configure and identity-commit interruptions retain enough scope to remove only the accepted account',async t=>{
 for(const fault of ['configureAfter','settleAfterLogin']){
  const f=await fixture(t)
  if(fault==='settleAfterLogin'){await f.run();await f.activate(f.b)}
  f.faults[fault]=true;const target=fault==='configureAfter'?f.a:f.b
  await assert.rejects(f.run(target),/configure acknowledgement|journal/)
  await f.erase(target);f.faults[fault]=false;await f.restart();await f.controller.eraseDeletedAccount(target.accountId)
  assert.equal(f.cache.has(target.billingCustomerId),false);assert.equal((await f.local.billingIdentity.read()).current,null)
 }
})
test('deleted previous identity is detached before a new account can configure a purchase',async t=>{
 const f=await fixture(t);await f.run();await f.erase();await f.restart();await f.activate(f.b);await f.run(f.b)
 assert.equal(f.native.user,f.b.billingCustomerId);assert.deepEqual(f.calls.map(c=>c[0]),['configure','configure','logout','configure','configure'])
})

test('returning to the original configuration after deleting a different account cannot reuse its anonymous identity',async t=>{
 const f=await fixture(t);await f.run();await f.activate(f.b);await f.run(f.b);await f.erase(f.b)
 const returning={...f.a,sessionId:'sess_returning'}
 await f.controller.eraseDeletedAccount(f.b.accountId);await f.activate(returning);await f.run(returning)
 assert.equal(f.native.user,f.a.billingCustomerId)
 assert.deepEqual(f.calls.map(c=>c[0]),['configure','login','logout','configure','configure'])
 assert.deepEqual((await f.local.billingIdentity.read()).current,returning)
})

test('interrupted anonymous reconfiguration resumes durably without an anonymous login or loss of the next account',async t=>{
 for(const afterExplicit of [false,true]){
  const f=await fixture(t);await f.run();await f.erase();await f.controller.eraseDeletedAccount(f.a.accountId);await f.activate(f.b)
  const configure=f.driver.configure
  f.driver.configure=async(identity,resume)=>{await configure(identity,resume);if(resume!==afterExplicit)throw Error('Reconfiguration interrupted')}
  await assert.rejects(f.run(f.b),/Reconfiguration interrupted/)
  assert.equal((await f.local.billingIdentity.read()).pending.accountId,f.b.accountId)
  f.driver.configure=configure;await f.restart();await f.run(f.b)
  assert.equal(f.native.user,f.b.billingCustomerId);assert.equal(f.calls.some(c=>c[0]==='login'),false)
  assert.deepEqual((await f.local.billingIdentity.read()).current,f.b)
 }
})
test('unknown native identities and changed projects are preserved and cannot be silently reassigned',async t=>{
 const f=await fixture(t);await f.run();const before=await f.local.billingIdentity.read()
 await assert.rejects(f.run({...f.a,publicSdkKey:'appl_other'}),/configuration changed/)
 assert.deepEqual(await f.local.billingIdentity.read(),before)
 f.native.user=randomUUID();await f.erase();await assert.rejects(f.controller.eraseDeletedAccount(f.a.accountId),/cleanup needs/)
 assert.equal(f.calls.some(c=>c[0]==='logout'),false);assert.deepEqual(await f.local.billingIdentity.read(),before)
})
test('a delayed native readiness check cannot configure billing after parent access changes',async t=>{
 const f=await fixture(t);await f.run();await f.restart();let allowed=true
 f.driver.isConfigured=async()=>{allowed=false;return false}
 await assert.rejects(f.controller.run(f.a,()=>{if(!allowed)throw Error('Parent access changed')},async()=>assert.fail()),/Parent access changed/)
 assert.equal(f.calls.length,1);assert.equal(f.native.configured,false)
})

test('a first-use readiness check cannot initialize billing after parent access changes',async t=>{
 const f=await fixture(t);let allowed=true,checks=0
 f.driver.isConfigured=async()=>{if(++checks===2)allowed=false;return false}
 await assert.rejects(f.controller.run(f.a,()=>{if(!allowed)throw Error('Parent access changed')},async()=>assert.fail()),/Parent access changed/)
 assert.equal(f.calls.length,0);assert.equal(f.native.configured,false)
 assert.equal((await f.local.billingIdentity.read()).pending.accountId,f.a.accountId)
})
test('session and kiosk restrictions are checked durably before creating a new identity transition',async t=>{
 const f=await fixture(t);await f.local.notificationSessions.close(f.a)
 await assert.rejects(f.run(),/sign-in changed/);assert.equal(f.calls.length,0)
 await f.activate({...f.a,sessionId:'sess_new'});await assert.rejects(f.run(),/sign-in changed/)
 const current={...f.a,sessionId:'sess_new'}
 await f.local.cacheBoard(current.accountId,{household:{id:current.householdId,name:'Family',role:'manager',leaderId:current.accountId,timezone:'Australia/Sydney'},members:[],tasks:[],fetchedAt:'2026-11-04T01:00:00.000Z'})
 await f.local.kiosk.begin({...current,id:randomUUID(),state:'locked',visibleMemberIds:[],editableMemberIds:[]})
 await assert.rejects(f.run(current),/Unlock kiosk/);assert.equal(f.calls.length,0)
})
test('stale journal acknowledgements cannot clear another transition; malformed recovery fails closed',async t=>{
 const f=await fixture(t),empty=await f.local.billingIdentity.read();await f.run()
 await assert.rejects(f.local.billingIdentity.settle(empty,null),/needs recovery/)
 await f.db.runAsync('UPDATE native_billing_identity SET data=? WHERE id=1','{"current":{},"pending":null}')
 await assert.rejects(f.run(),/needs recovery/);assert.equal(f.calls.length,1)
})
test('native adapter uses supported configure/logout APIs, binds cleanup to the journal and sanitizes SDK errors',async t=>{
 const f=await fixture(t),configurations=[]
 const purchases={isConfigured:f.driver.isConfigured,getAppUserID:f.driver.current,isAnonymous:f.driver.isAnonymous,setLogLevel:async()=>{},
  configure:value=>{
   assert.ok(JSON.parse(f.db.raw.prepare('SELECT data FROM native_billing_identity').get().data).pending)
   configurations.push(value);f.native.configured=true;f.native.user=value.appUserID??f.native.user
  },logIn:f.driver.logIn,logOut:f.driver.logOut}
 const native=load(['mobile/src/services/native-billing-identity.ts'],{'../storage/native-store':{openLocalStore:async()=>f.local},'react-native-purchases':{default:purchases,__esModule:true,LOG_LEVEL:{ERROR:'ERROR'}}})
 const identity=await native.nativeBillingIdentity();await identity.run(f.a,()=>{},async()=>{})
 assert.equal(configurations[0].appUserID,f.a.billingCustomerId);assert.equal(configurations[0].automaticDeviceIdentifierCollectionEnabled,false)
 await f.erase();purchases.logOut=async()=>{throw Error('private provider credentials')}
 await assert.rejects(native.eraseNativeBillingIdentity(f.a.accountId),error=>error.message.includes('Store identity could not')&&!error.message.includes('private'))
 assert.equal((await f.local.billingIdentity.read()).current.accountId,f.a.accountId)
 purchases.logOut=f.driver.logOut;await native.eraseNativeBillingIdentity(f.a.accountId)
 assert.equal((await f.local.billingIdentity.read()).current,null)
})
test('billing or Clerk cleanup failure cannot prevent kiosk/notification cleanup or remove the recovery receipt',async t=>{
 const f=await fixture(t),secure=new Map(),calls=[];let failBilling=true,failCache=false,failNative=false
 const native=load(['mobile/src/services/native-account-deletion.ts'],{
  '../storage/native-store':{openLocalStore:async()=>f.local,nativeKioskVault:{remove:async id=>calls.push(['pin',id])}},
  './native-billing-identity':{eraseNativeBillingIdentity:async id=>{calls.push(['billing',id]);if(failBilling)throw Error('Billing unavailable')}},
  './native-clerk-offline-cache':{eraseNativeClerkOfflineCache:async id=>{calls.push(['clerk-cache',id]);if(failCache)throw Error('Keychain unavailable')}},
  './native-clerk-deletion':{verifyNativeClerkDeletion:async id=>{calls.push(['clerk-native',id]);if(failNative)throw Error('Native profile still present')}},
  './notification-native-session':{resetNativeNotificationSession:async()=>{calls.push(['notifications'])},waitForNativeNotification:work=>work},
  'expo-crypto':{CryptoDigestAlgorithm:{SHA256:'sha256'},digestStringAsync:async(algorithm,value)=>createHash(algorithm).update(value).digest('hex'),getRandomBytesAsync:async size=>randomBytes(size)},
  'expo-secure-store':{WHEN_UNLOCKED_THIS_DEVICE_ONLY:1,getItemAsync:async key=>secure.get(key)??null,setItemAsync:async(key,value)=>secure.set(key,value),deleteItemAsync:async key=>secure.delete(key)},
  'expo/fetch':{fetch:async()=>assert.fail('Accepted local cleanup must not need an HTTP response')},
 })
 const requestId=randomUUID(),drafts=native.nativeAccountDeletionDrafts(f.local.accountDeletion)
 const saved=await drafts.prepare({...f.a,origin:'https://www.cyntch.com',intent:{operationId:requestId,revision:'a'.repeat(64),ownership:[],confirmAccountDeletion:true,acknowledgeSubscriptions:true}})
 await drafts.requestForSubmission(saved,f.a)
 await f.local.cacheBoard(f.a.accountId,{household:{id:f.a.householdId,name:'Family',role:'manager',leaderId:f.a.accountId,timezone:'Australia/Sydney'},members:[],tasks:[],fetchedAt:'2026-11-04T01:00:00.000Z'})
 const kioskId=randomUUID();await f.local.kiosk.begin({...f.a,id:kioskId,state:'locked',visibleMemberIds:[],editableMemberIds:[]})
 const recovery=await native.nativeAccountDeletionRecovery()
 await assert.rejects(recovery.rememberStatus(saved,{requestId,state:'pending',acceptedAt:'2026-11-04T01:00:00.000Z',completedAt:null,availableUntil:null,appleRevocationRequired:false}),/Some device cleanup/)
 assert.equal(recovery.getSnapshot().localCleanupComplete,false);assert.equal((await native.nativeAccountDeletionVault.read()).secret,saved.secret)
 assert.ok(calls.some(call=>call[0]==='notifications'));assert.ok(calls.some(call=>call[0]==='clerk-cache'));assert.ok(calls.some(call=>call[0]==='pin'&&call[1]===kioskId));assert.deepEqual(await f.local.deletedAccounts.pendingKioskKeys(f.a.accountId),[])
 failBilling=false;failCache=true;await assert.rejects(recovery.refresh(),/Some device cleanup/)
 assert.equal(recovery.getSnapshot().localCleanupComplete,false);assert.equal((await native.nativeAccountDeletionVault.read()).secret,saved.secret)
 failCache=false;failNative=true;await assert.rejects(recovery.refresh(),/Some device cleanup/)
 assert.equal(recovery.getSnapshot().localCleanupComplete,false);assert.equal((await native.nativeAccountDeletionVault.read()).secret,saved.secret)
 assert.equal(calls.filter(call=>call[0]==='notifications').length,3)
 failNative=false;await recovery.refresh();assert.equal(recovery.getSnapshot().localCleanupComplete,true)
 assert.equal(calls.filter(call=>call[0]==='pin').length,1)

 await recovery.rememberStatus(saved,{requestId,state:'completed',acceptedAt:'2026-11-04T01:00:00.000Z',completedAt:'2026-11-04T02:00:00.000Z',availableUntil:'2027-02-02T02:00:00.000Z',appleRevocationRequired:false})
 await recovery.dismissCompleted(saved);assert.equal(await native.nativeAccountDeletionVault.read(),null)
 await f.local.notificationSessions.activate(f.b)
 await f.local.cacheBoard(f.b.accountId,{household:{id:f.b.householdId,name:'Other family',role:'manager',leaderId:f.b.accountId,timezone:'Australia/Sydney'},members:[],tasks:[],fetchedAt:'2026-11-04T02:00:00.000Z'})
 await f.local.kiosk.begin({...f.b,id:randomUUID(),state:'locked',visibleMemberIds:[],editableMemberIds:[]})
 const notifications=await f.db.getAllAsync('SELECT * FROM notification_sessions'),kiosk=await f.local.kiosk.get()
 calls.length=0;failNative=true
 await assert.rejects(recovery.recoverIdentity(),/still need cleanup/)
 assert.deepEqual(calls,[['billing',f.a.accountId],['clerk-cache',f.a.accountId],['clerk-native',f.a.accountId]])
 assert.deepEqual(await f.db.getAllAsync('SELECT * FROM notification_sessions'),notifications,'Retired cleanup cannot reset the current member\'s notification session')
 assert.deepEqual(await f.local.kiosk.get(),kiosk,'Retired cleanup cannot unlock another member\'s kiosk')
 failNative=false;await recovery.recoverIdentity();assert.equal(recovery.getSnapshot().localCleanupComplete,true)
})
