/* eslint-disable @typescript-eslint/no-require-imports -- Validate the installed native bridge boundary without real credentials. */
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module'),{buildSync}=require('esbuild'),root=path.resolve(__dirname,'..')
function load(files,mocks={}){const loaded=new Module(__filename,module);loaded.require=name=>mocks[name]??require(name);loaded._compile(buildSync({stdin:{contents:files.map(file=>`export * from ${JSON.stringify(path.join(root,file))}`).join(';'),resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:Object.keys(mocks)}).outputFiles[0].text,__filename);return loaded.exports}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
function fixture(){
 const calls=[],state={ready:true,hasAccount:false,hasUnidentifiedSession:false,hasAuthenticationSnapshot:false,format:1}
 const persisted={...state}
 let loaded=true,deleted=true,available=true
 const clerk={loaded:true,user:{id:'user_b'},client:{sessions:[{id:'sess_b',user:{id:'user_b'}}],signIn:{id:null},signUp:{id:null},reload:async()=>{calls.push('reload-js')}}}
 const bridge={getAuthFlowState:async()=>({isLoaded:loaded}),refreshClient:async()=>{calls.push('refresh')}}
 const inspector={inspectAccount:async accountId=>{calls.push(['inspect',accountId]);return {...state,privatePayload:'never expose this'}},
  inspectPersistence:async accountId=>{calls.push(['persisted',accountId]);return {...persisted,privatePayload:'never expose this'}},
  forgetBiometricCredentials:async accountId=>{calls.push(['forget-biometric',accountId]);return {format:1,removedCount:0}}}
 const api=load(['mobile/modules/cyntch-clerk-state/index.ts','mobile/src/services/native-clerk-deletion.ts'],{
  expo:{requireOptionalNativeModule:name=>available?(name==='ClerkExpo'?bridge:name==='CyntchClerkState'?inspector:null):null},
  '@clerk/expo':{getClerkInstance:()=>clerk},'../storage/native-store':{openLocalStore:async()=>({deletedAccounts:{isDeleted:async()=>deleted}})},
 })
 return {api,calls,state,persisted,clerk,bridge,inspector,setLoaded:value=>{loaded=value},setDeleted:value=>{deleted=value},setAvailable:value=>{available=value}}
}
test('an absent or loading native bridge never becomes evidence that an account was erased',async()=>{
 const f=fixture();f.setAvailable(false);await assert.rejects(f.api.inspectNativeClerkAccount('user_a'),/could not be verified/)
 f.setAvailable(true);f.setLoaded(false);await assert.rejects(f.api.inspectNativeClerkAccount('user_a'),/could not be verified/)
 assert.deepEqual(f.calls,[])
 f.setLoaded(true);f.bridge.refreshClient=async()=>{f.setLoaded(false)}
 await assert.rejects(f.api.inspectNativeClerkAccount('user_a',true),/could not be verified/);assert.deepEqual(f.calls,[])
})
test('inspection exposes only the account-presence verdict and rejects incompatible native payloads',async()=>{
 const f=fixture();assert.deepEqual(await f.api.inspectNativeClerkAccount('user_a'),f.state)
 f.state.ready='true';await assert.rejects(f.api.inspectNativeClerkAccount('user_a'),/could not be verified/)
 f.inspector.inspectAccount=async()=>{throw Error('private token')}
 await assert.rejects(f.api.inspectNativeClerkAccount('user_a'),error=>!error.message.includes('private'))
 await assert.rejects(f.api.inspectNativeClerkAccount('bad'),/could not be verified/)
})
test('cleanup cannot refresh or inspect native identity without an accepted local deletion',async()=>{
 const f=fixture();f.setDeleted(false);await assert.rejects(f.api.verifyNativeClerkDeletion('user_a'),/still being verified/);assert.deepEqual(f.calls,[])
})
test('old native profiles, unidentified sessions and authentication snapshots keep cleanup incomplete',async()=>{
 for(const key of ['hasAccount','hasUnidentifiedSession','hasAuthenticationSnapshot','ready']){
  const f=fixture();f.state[key]=key!=='ready';await assert.rejects(f.api.verifyNativeClerkDeletion('user_a'),/still being verified/)
  assert.deepEqual(f.calls,[['forget-biometric','user_a'],'refresh',['inspect','user_a']])
 }
})
test('the JS client must also have retired the deleted account and its unscoped authentication snapshots',async()=>{
 const mutations=[f=>{f.clerk.loaded=false},f=>{f.clerk.user={id:'user_a'}},f=>{f.clerk.client.sessions=[{user:{id:'user_a'}}]},
  f=>{f.clerk.client.sessions=[{user:null}]},f=>{f.clerk.client.signIn.id='sia_pending'},f=>{f.clerk.client.signUp.id='sua_pending'}]
 for(const change of mutations){const f=fixture();change(f);await assert.rejects(f.api.verifyNativeClerkDeletion('user_a'),/still being verified/)}
})
test('verifying a deleted account preserves another signed-in account and never clears a shared credential',async()=>{
 const f=fixture(),before=JSON.stringify(f.clerk);await f.api.verifyNativeClerkDeletion('user_a')
 assert.equal(JSON.stringify(f.clerk),before);assert.deepEqual(f.calls,[['forget-biometric','user_a'],'refresh',['inspect','user_a'],'reload-js',['persisted','user_a'],['inspect','user_a']])
})

test('an absent, incompatible or unreadable persisted-profile inspector cannot establish cleanup',async()=>{
 const f=fixture();f.inspector.inspectPersistence=undefined
 await assert.rejects(f.api.verifyNativeClerkDeletion('user_a'),/still being verified/)
 f.inspector.inspectPersistence=async()=>({...f.persisted,format:2})
 await assert.rejects(f.api.inspectNativeClerkPersistence('user_a'),/could not be verified/)
 f.inspector.inspectPersistence=async()=>{throw Error('private cached account data')}
 await assert.rejects(f.api.inspectNativeClerkPersistence('user_a'),error=>!error.message.includes('private'))
 f.setLoaded(false);let inspected=false;f.inspector.inspectPersistence=async()=>{inspected=true;return f.persisted}
 await assert.rejects(f.api.inspectNativeClerkPersistence('user_a'),/could not be verified/);assert.equal(inspected,false)
 f.setLoaded(true);f.inspector.inspectPersistence=async()=>{f.setLoaded(false);return f.persisted}
 await assert.rejects(f.api.inspectNativeClerkPersistence('user_a'),/could not be verified/)
})

test('a cleared memory client cannot hide an older disk profile, ambiguous session or authentication snapshot',async()=>{
 for(const key of ['hasAccount','hasUnidentifiedSession','hasAuthenticationSnapshot','ready']){
  const f=fixture();f.persisted[key]=key!=='ready'
  await assert.rejects(f.api.verifyNativeClerkDeletion('user_a'),/still being verified/)
  assert.deepEqual(f.calls,[['forget-biometric','user_a'],'refresh',['inspect','user_a'],'reload-js',['persisted','user_a']])
  f.persisted[key]=key==='ready';await f.api.verifyNativeClerkDeletion('user_a')
 }
 const f=fixture();assert.deepEqual(await f.api.inspectNativeClerkPersistence('user_a'),f.persisted)
})

test('native-to-JS propagation is refreshed explicitly, and both clients are rechecked afterward',async()=>{
 const f=fixture();f.clerk.client.sessions.push({id:'sess_a',user:{id:'user_a'}})
 f.clerk.client.reload=async()=>{f.clerk.client.sessions=f.clerk.client.sessions.filter(session=>session.user.id!=='user_a')}
 await f.api.verifyNativeClerkDeletion('user_a');assert.equal(f.clerk.client.sessions[0].user.id,'user_b')
 f.clerk.client.reload=async()=>{f.state.hasAccount=true}
 await assert.rejects(f.api.verifyNativeClerkDeletion('user_a'),/still being verified/)
 f.state.hasAccount=false;f.clerk.client.reload=async()=>{throw Error('private network response')}
 await assert.rejects(f.api.verifyNativeClerkDeletion('user_a'),error=>error.message.includes('still being verified')&&!error.message.includes('private'))
})

test('missing, failing or incompatible private-key cleanup cannot be reported as a successful deletion',async()=>{
 const f=fixture();f.inspector.forgetBiometricCredentials=undefined
 await assert.rejects(f.api.verifyNativeClerkDeletion('user_a'),/still being verified/);assert.deepEqual(f.calls,[])
 for(const result of [null,{format:2,removedCount:0},{format:1,removedCount:'0'},{format:1,removedCount:-1},{format:1,removedCount:NaN}]){
  f.inspector.forgetBiometricCredentials=async()=>result
  await assert.rejects(f.api.verifyNativeClerkDeletion('user_a'),/still being verified/);assert.deepEqual(f.calls,[])
 }
 f.inspector.forgetBiometricCredentials=async()=>{throw Error('private key metadata')}
 await assert.rejects(f.api.forgetNativeClerkBiometricCredentials('user_a'),error=>!error.message.includes('private key'))
 f.setLoaded(false);let erased=false;f.inspector.forgetBiometricCredentials=async()=>{erased=true;return {format:1,removedCount:0}}
 await assert.rejects(f.api.forgetNativeClerkBiometricCredentials('user_a'),/could not be verified/);assert.equal(erased,false)
 f.setLoaded(true);f.inspector.forgetBiometricCredentials=async()=>{f.setLoaded(false);return {format:1,removedCount:0}}
 await assert.rejects(f.api.forgetNativeClerkBiometricCredentials('user_a'),/could not be verified/)
})

test('private-key cleanup remains serialized after a timeout, and a failed network refresh can be retried safely',async()=>{
 const f=fixture(),entered=deferred(),finish=deferred();let erasures=0
 f.inspector.forgetBiometricCredentials=async accountId=>{assert.equal(accountId,'user_a');erasures++;if(erasures===1){entered.resolve();await finish.promise};return {format:1,removedCount:erasures===1?1:0}}
 const first=assert.rejects(f.api.verifyNativeClerkDeletion('user_a',20),/still being verified/)
 await entered.promise;await first
 const second=f.api.verifyNativeClerkDeletion('user_a',2000);await new Promise(resolve=>setImmediate(resolve));assert.equal(erasures,1);assert.deepEqual(f.calls,[])
 finish.resolve();await second;assert.equal(erasures,1,'Retries join the same timed-out operation until it settles')
 f.bridge.refreshClient=async()=>{throw Error('offline')}
 await assert.rejects(f.api.verifyNativeClerkDeletion('user_a'),/still being verified/);assert.equal(erasures,2)
 f.bridge.refreshClient=async()=>{};await f.api.verifyNativeClerkDeletion('user_a');assert.equal(erasures,3)
})
test('a UI timeout retains the native verification queue until the original refresh finishes',async()=>{
 const f=fixture(),entered=deferred(),finish=deferred();let started=0
 f.bridge.refreshClient=async()=>{started++;if(started===1){entered.resolve();await finish.promise}}
 const first=f.api.verifyNativeClerkDeletion('user_a',20);const failed=assert.rejects(first,/still being verified/)
 await entered.promise;await failed
 const second=f.api.verifyNativeClerkDeletion('user_a',2000);await new Promise(resolve=>setImmediate(resolve));assert.equal(started,1)
 finish.resolve();await second;assert.equal(started,1)
 await f.api.verifyNativeClerkDeletion('user_a');assert.equal(started,2,'A later lifecycle event can perform a fresh inspection')
})

test('readiness, identity and foreground events recover accepted and dismissed accounts without polling or render loops',async()=>{
 const state={record:{status:{state:'pending'}},deletedAccounts:[],localCleanupComplete:false,busy:false,error:null}
 const auth={userId:'user_a',sessionId:'sess_a'},native={isLoaded:false,isAuthFlowComplete:false}
 let previous=[],retries=0,dispose
 const listeners=new Set(),appState={currentState:'active',addEventListener:(name,listener)=>{assert.equal(name,'change');listeners.add(listener);return {remove:()=>listeners.delete(listener)}}}
 const emit=value=>{appState.currentState=value;for(const listener of listeners)listener(value)}
 const controller={getSnapshot:()=>state,subscribe:()=>()=>{},recoverIdentity:async()=>{retries++;state.error='Still verifying'}}
 const api=load(['mobile/src/providers/account-deletion-recovery.tsx'],{
  react:{createContext:()=>({}),useContext:()=>controller,useSyncExternalStore:(_subscribe,get)=>get(),
   useEffect:(effect,deps)=>{if(deps.some((value,index)=>value!==previous[index])){dispose?.();previous=deps;dispose=effect()}}},
  'react-native':{AppState:appState},'react/jsx-runtime':{},'@clerk/expo':{useAuth:()=>auth},
  '@clerk/expo/native-components':{useAuthViewState:()=>native},
  '../services/native-account-deletion':{},'../components/ui':{},
 })
 api.AccountDeletionIdentityRecovery();assert.equal(retries,0)
 native.isLoaded=true;api.AccountDeletionIdentityRecovery();assert.equal(retries,1)
 // Busy/error publications re-render the consumer but cannot schedule a loop.
 state.busy=true;api.AccountDeletionIdentityRecovery();state.busy=false;api.AccountDeletionIdentityRecovery();assert.equal(retries,1)
 native.isAuthFlowComplete=true;api.AccountDeletionIdentityRecovery();assert.equal(retries,2)
 auth.userId='user_b';auth.sessionId='sess_b';api.AccountDeletionIdentityRecovery();assert.equal(retries,3)
 state.localCleanupComplete=true;auth.sessionId='sess_b_new';api.AccountDeletionIdentityRecovery();assert.equal(retries,4,'A prior success cannot suppress cleanup after a new identity event')
 state.localCleanupComplete=false;state.record={status:null};native.isAuthFlowComplete=false;api.AccountDeletionIdentityRecovery();assert.equal(retries,4)
 state.record=null;state.deletedAccounts=['user_a'];emit('background');emit('active');assert.equal(retries,5,'Dismissed receipts still need foreground recovery')
 emit('active');assert.equal(retries,5,'Repeated active events are not foreground transitions')
 state.busy=true;api.AccountDeletionIdentityRecovery();state.busy=false;api.AccountDeletionIdentityRecovery();assert.equal(retries,5)
 assert.equal(listeners.size,1);native.isLoaded=false;api.AccountDeletionIdentityRecovery();assert.equal(listeners.size,0)
 emit('background');emit('active');assert.equal(retries,5)
})
