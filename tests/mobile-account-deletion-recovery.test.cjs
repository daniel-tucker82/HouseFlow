/* eslint-disable @typescript-eslint/no-require-imports -- Durable secure-store and native transport interruption tests. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto')
const path=require('node:path'),Module=require('node:module'),{buildSync}=require('esbuild'),root=path.resolve(__dirname,'..')
const loaded=new Module(__filename,module)
loaded._compile(buildSync({stdin:{contents:['mobile/src/storage/account-deletion-vault.ts','mobile/src/services/account-deletion-status.ts','shared/mobile/account-deletion.ts'].map(file=>`export * from ${JSON.stringify(path.join(root,file))}`).join(';'),resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,__filename)
const {AccountDeletionVault,AccountDeletionStatusApi,parseAccountDeletionStatus,validAccountDeletionRecovery,accountDeletionOrigin}=loaded.exports
const origin='https://www.cyntch.test',endpoint=origin+'/api/mobile/account-deletion/status',key='cyntch.account-deletion-recovery'
const intentHash='c'.repeat(64)
const submit=async(vault,saved)=>{await vault.bindIntent(saved,intentHash);return vault.markSubmitted(saved,intentHash)}
const pending=id=>({requestId:id,state:'pending',acceptedAt:'2026-11-04T01:00:00.000Z',completedAt:null,availableUntil:null,appleRevocationRequired:false})
const completed=id=>({...pending(id),state:'completed',completedAt:'2026-11-04T01:00:15.000Z',availableUntil:'2027-02-02T01:00:15.000Z'})
function fixture(){
 const saved=new Map(),id=randomUUID(),account='user_parent',control={failWrite:false,failRemove:false,afterWrite:false,randomCalls:0}
 const storage={get:async key=>saved.get(key)??null,set:async(key,value)=>{
  if(control.failWrite)throw new Error('Storage is locked')
  saved.set(key,value);if(control.afterWrite)throw new Error('Lost write acknowledgement')
 },remove:async key=>{if(control.failRemove)throw new Error('Storage is locked');saved.delete(key)}}
 const random=async()=>{control.randomCalls++;return randomBytes(32).toString('hex')}
 let vault=new AccountDeletionVault(storage,random)
 return {saved,id,account,control,storage,random,get vault(){return vault},restart:()=>{vault=new AccountDeletionVault(storage,random)},prepare:()=>vault.prepare(origin,account,id)}
}
const response=(body,options={})=>({url:endpoint,redirected:false,status:200,headers:new Headers(),json:async()=>body,...options})

test('recovery key is saved before returning and concurrent preparation or restarts reuse the same key',async()=>{
 const f=fixture(),records=await Promise.all([f.prepare(),f.prepare(),f.prepare()])
 assert.equal(f.control.randomCalls,1);assert.deepEqual(records[0],records[1]);assert.deepEqual(records[1],records[2])
 assert.equal(f.saved.size,1);assert.deepEqual(JSON.parse(f.saved.get(key)),records[0]);assert.equal(records[0].submitted,false)
 f.restart();assert.deepEqual(await f.prepare(),records[0]);assert.equal(f.control.randomCalls,1)
 for(const args of [[origin,'user_other',f.id],[origin,f.account,randomUUID()],['https://other.test',f.account,f.id]])await assert.rejects(f.vault.prepare(...args),/Resolve the saved deletion/)
})

test('failed secure persistence prevents submission and a lost write acknowledgement preserves the existing key',async()=>{
 const f=fixture();f.control.failWrite=true
 await assert.rejects(f.prepare(),/Storage is locked/);assert.equal(await f.vault.read(),null)
 f.control.failWrite=false;f.control.afterWrite=true
 await assert.rejects(f.prepare(),/Lost write acknowledgement/)
 const saved=JSON.parse(f.saved.get(key));f.restart();f.control.afterWrite=false
 assert.deepEqual(await f.prepare(),saved);assert.equal(f.control.randomCalls,2)
 await f.vault.bindIntent(saved,intentHash)
 f.control.failWrite=true;await assert.rejects(f.vault.markSubmitted(saved,intentHash),/Storage is locked/)
 assert.equal((await f.vault.read()).submitted,false)
 f.control.failWrite=false;f.control.afterWrite=true;await assert.rejects(f.vault.markSubmitted(saved,intentHash),/Lost write acknowledgement/)
 f.restart();f.control.afterWrite=false;assert.equal((await f.vault.read()).submitted,true)
 await assert.rejects(f.vault.discardPrepared(saved),/submitted deletion/)
})

test('prepared cancellation cannot erase a concurrently submitted request or remove another recovery key',async()=>{
 const f=fixture(),saved=await f.prepare()
 await assert.rejects(f.vault.markSubmitted({...saved,secret:'0'.repeat(64)},intentHash),/unavailable/)
 await assert.rejects(f.vault.markSubmitted(saved,intentHash),/unavailable/,'Unbound intent cannot submit')
 await f.vault.bindIntent(saved,intentHash)
 const submitted=f.vault.markSubmitted(saved,intentHash),discarded=assert.rejects(f.vault.discardPrepared(saved),/submitted deletion/)
 await submitted;await discarded;assert.equal((await f.vault.read()).submitted,true)
 const g=fixture(),prepared=await g.prepare();await g.vault.discardPrepared(prepared);assert.equal(await g.vault.read(),null)
 await assert.rejects(g.vault.markSubmitted(prepared,intentHash),/unavailable/)
})

test('confirmed status persists after restart and cannot regress or lose manual Apple instructions',async()=>{
 const f=fixture(),saved=await f.prepare()
 await assert.rejects(f.vault.rememberStatus(saved,pending(f.id)),/unavailable/)
 await submit(f.vault,saved)
 await f.vault.rememberStatus(saved,{...pending(f.id),appleRevocationRequired:true})
 f.restart();assert.equal((await f.vault.read()).status.appleRevocationRequired,true)
 await assert.rejects(f.vault.rememberStatus(saved,pending(randomUUID())),/invalid account deletion status/)
 await assert.rejects(f.vault.rememberStatus(saved,{...pending(f.id),acceptedAt:'2026-11-03T01:00:00.000Z'}),/unavailable/)
 const done=await f.vault.rememberStatus(saved,completed(f.id));assert.equal(done.status.appleRevocationRequired,true)
 assert.deepEqual(await f.vault.rememberStatus(saved,pending(f.id)),done)
 f.restart();assert.deepEqual(await f.vault.read(),done)
 f.control.failRemove=true;await assert.rejects(f.vault.dismissCompleted(saved),/Storage is locked/);assert.deepEqual(await f.vault.read(),done)
 f.control.failRemove=false;await f.vault.dismissCompleted(saved);assert.equal(await f.vault.read(),null)
})

test('a failed receipt save leaves recovery intact for another authenticated read',async()=>{
 const f=fixture(),saved=await f.prepare();await submit(f.vault,saved);f.control.failWrite=true
 await assert.rejects(f.vault.rememberStatus(saved,completed(f.id)),/Storage is locked/)
 f.restart();assert.equal((await f.vault.read()).status,null)
 await assert.rejects(f.vault.dismissCompleted(saved),/not been confirmed/)
 f.control.failWrite=false;await f.vault.rememberStatus(saved,completed(f.id));assert.equal((await f.vault.read()).status.state,'completed')
})

test('corrupt storage fails closed and never silently replaces a saved recovery key',async()=>{
 const f=fixture(),saved=await f.prepare()
 for(const value of ['{',JSON.stringify({...saved,secret:'short'}),JSON.stringify({...saved,status:pending(f.id)}),JSON.stringify({...saved,origin:'http://insecure.test'}),JSON.stringify({...saved,accountId:'local_child'})]){
  f.saved.set(key,value)
  await assert.rejects(f.vault.read(),/unavailable/);await assert.rejects(f.prepare(),/unavailable/);assert.equal(f.saved.get(key),value)
 }
 assert.equal(f.control.randomCalls,1)
})

test('status transport sends only the recovery headers to its bound origin without sign-in or redirects',async()=>{
 const f=fixture(),saved=await f.prepare(),calls=[]
 const api=new AccountDeletionStatusApi(origin,async(...args)=>{calls.push(args);return response({...pending(f.id),accountId:'must-not-leak',work:{private:true}})})
 assert.deepEqual(await api.read(saved),pending(f.id))
 assert.equal(calls.length,1)
 const [url,options]=calls[0];assert.equal(url,endpoint);assert.equal(url.includes(saved.secret),false);assert.equal(options.method,'GET')
 assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer')
 assert.deepEqual(options.headers,{Accept:'application/json','X-Cyntch-Deletion-Request':f.id,'X-Cyntch-Deletion-Key':saved.secret})
 await assert.rejects(api.read({...saved,origin:'https://other.test'}),{code:'unavailable'});assert.equal(calls.length,1)
})

test('failed status reads keep submitted recovery intact and surface only safe retry messages',async()=>{
 const f=fixture(),saved=await f.prepare();await submit(f.vault,saved)
 const before=await f.vault.read()
 for(const [http,code]of[[404,'unavailable'],[429,'limited'],[500,'retry'],[401,'retry'],[204,'retry']]){
  const api=new AccountDeletionStatusApi(origin,async()=>response({error:saved.secret},{status:http}))
  await assert.rejects(api.read(saved),error=>{assert.equal(error.code,code);assert.equal(error.message.includes(saved.secret),false);if(http===429)assert.equal(error.retryAfterMs,60_000);return true})
  assert.deepEqual(await f.vault.read(),before)
 }
 const api=new AccountDeletionStatusApi(origin,async()=>{throw new Error('Network failed: '+saved.secret)})
 await assert.rejects(api.read(saved),error=>error.code==='retry'&&!error.message.includes(saved.secret))
 f.restart();assert.deepEqual(await f.vault.read(),before)
})

test('status transport rejects changed origins, redirected responses and inconsistent receipts',async()=>{
 const f=fixture(),saved=await f.prepare()
 for(const reply of [response(pending(f.id),{url:'https://other.test/status'}),response(pending(f.id),{redirected:true}),response(pending(randomUUID())),response({...pending(f.id),state:'completed'}),response(null),response(null,{json:async()=>{throw new SyntaxError('Bad reply')}})]){
  await assert.rejects(new AccountDeletionStatusApi(origin,async()=>reply).read(saved),{code:'retry'})
 }
 for(const delay of ['120','0','999999','Wed, 01 Jan 2020 00:00:00 GMT']){
  const api=new AccountDeletionStatusApi(origin,async()=>response(null,{status:429,headers:new Headers({'retry-after':delay})}))
  await assert.rejects(api.read(saved),{code:'limited',retryAfterMs:delay==='120'?120_000:60_000})
 }
})

test('status requests can be cancelled without deleting the saved recovery information',async()=>{
 const f=fixture(),saved=await f.prepare(),controller=new AbortController()
 let began,abortSeen=false;const entered=new Promise(resolve=>{began=resolve})
 const api=new AccountDeletionStatusApi(origin,async(_,options)=>new Promise((_,reject)=>{
  options.signal.addEventListener('abort',()=>{abortSeen=true;reject(new Error('Native cancellation'))},{once:true});began()
 }))
 const checking=assert.rejects(api.read(saved,controller.signal),{code:'cancelled'})
 await entered;controller.abort();await checking;assert.equal(abortSeen,true);assert.deepEqual(await f.vault.read(),saved)
 await assert.rejects(new AccountDeletionStatusApi(origin,async()=>assert.fail('Aborted request sent')).read(saved,controller.signal),{code:'cancelled'})
})

test('the status timeout covers a stalled response body and cleans up its timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const f=fixture(),saved=await f.prepare();let bodyStarted
 const entered=new Promise(resolve=>{bodyStarted=resolve})
 const api=new AccountDeletionStatusApi(origin,async(_,options)=>response(null,{json:()=>new Promise((_,reject)=>{
  options.signal.addEventListener('abort',()=>reject(new Error('Timed out')),{once:true});bodyStarted()
 })}))
 const checking=assert.rejects(api.read(saved),{code:'retry'})
 await entered;t.mock.timers.tick(25_000);await checking;assert.deepEqual(await f.vault.read(),saved)
})

test('status contracts reject incomplete or impossible receipts and discard unneeded private fields',()=>{
 const id=randomUUID(),valid=completed(id)
 assert.deepEqual(parseAccountDeletionStatus({...valid,work:{token:'private'},accountId:'user_private'},id),valid)
 for(const value of [null,[],{}, {...valid,appleRevocationRequired:1},{...valid,state:'failed'},{...valid,completedAt:null},{...valid,availableUntil:valid.completedAt},
  {...valid,completedAt:'2026-11-04T00:00:00.000Z'},{...valid,acceptedAt:'2026-02-30T01:00:00.000Z'},{...valid,acceptedAt:'0'}, {...pending(id),completedAt:valid.completedAt}]){
  assert.throws(()=>parseAccountDeletionStatus(value,id),/invalid account deletion status/)
 }
 assert.equal(validAccountDeletionRecovery({requestId:id,secret:'a'.repeat(64)}),true)
 for(const value of [null,[],{}, {requestId:'invalid',secret:'a'.repeat(64)},{requestId:id,secret:'A'.repeat(64)}])assert.equal(validAccountDeletionRecovery(value),false)
})

test('recovery origin configuration only permits HTTPS or explicit local development addresses',()=>{
 assert.equal(accountDeletionOrigin(origin+'/'),origin)
 for(const address of ['http://example.com','file:///tmp/test','https://user:pass@cyntch.test','https://cyntch.test/path','https://cyntch.test/?key=secret','https://cyntch.test/#key','garbage'])assert.throws(()=>accountDeletionOrigin(address,true))
 for(const address of ['http://localhost:3010','http://127.0.0.1:3010','http://10.0.2.2:3010','http://[::1]:3010']){
  assert.throws(()=>accountDeletionOrigin(address));assert.equal(accountDeletionOrigin(address,true),address)
 }
})

test('only exact self-authenticated status and scheduler endpoints bypass identity middleware',async()=>{
 const calls=[],protectedPaths=[]
 const mocks={'@clerk/nextjs/server':{
  createRouteMatcher:patterns=>request=>patterns.some(pattern=>request.nextUrl.pathname.startsWith(pattern.replace('(.*)',''))),
  clerkMiddleware:handler=>async(request,event)=>{calls.push(request.nextUrl.pathname);return handler({protect:async()=>protectedPaths.push(request.nextUrl.pathname)},request,event)},
 },'next/server':{NextResponse:{next:()=>new Response(null,{headers:{'x-middleware-next':'1'}})}}}
 const loaded=new Module(__filename,module);loaded.require=name=>mocks[name]??require(name)
 loaded._compile(buildSync({entryPoints:[path.join(root,'middleware.ts')],bundle:true,platform:'node',format:'cjs',write:false,external:Object.keys(mocks)}).outputFiles[0].text,__filename)
 const run=path=>loaded.exports.default({nextUrl:new URL(origin+path)},{})
 for(const path of ['/api/mobile/account-deletion/status','/api/internal/account-deletions','/api/internal/household-deletions','/api/internal/notifications','/api/cron','/api/internal/recurrence']){
  const response=await run(path);assert.ok(response,path+' must reach its own authentication guard');assert.equal(response.headers.get('x-middleware-next'),'1')
 }
 assert.deepEqual(calls,[])
 for(const path of ['/api/mobile/account-deletion','/api/mobile/account-deletion/status/extra','/api/internal/account-deletions/extra','/api/internal/household-deletions/extra','/api/cron/extra',
  '/api/internal/recurrence/extra','/api/internal/notifications/extra','/api/mobile/notifications','/api/mobile/bootstrap','/app','/leader/settings','/member','/join/example'])await run(path)
 assert.equal(calls.length,13);assert.deepEqual(protectedPaths,['/app','/leader/settings','/member','/join/example'])
})
