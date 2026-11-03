/* eslint-disable @typescript-eslint/no-require-imports -- Bounded HTTP reads and provider lookup interruption. */
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module'),{buildSync}=require('esbuild')
const root=path.resolve(__dirname,'..')
function load(lookup){
 const loaded=new Module(__filename,module);loaded.require=name=>name==='@clerk/nextjs/server'?{clerkClient:async()=>({users:{getUserList:lookup}})}:name==='@/lib/db'?{}:require(name)
 loaded._compile(buildSync({entryPoints:[path.join(root,'lib/account-deletion-http.ts')],bundle:true,platform:'node',format:'cjs',write:false,external:['@clerk/nextjs/server','@/lib/db']}).outputFiles[0].text,__filename)
 return loaded.exports
}
test('stalled or aborted confirmation body closes its reader without accepting partial consent',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const lib=load(()=>assert.fail('No provider work for body reading'))
 let cancelled=false
 const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'))},cancel(){cancelled=true}})
 const request=new Request('https://cyntch.test/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:stream,duplex:'half'})
 const result=assert.rejects(lib.readAccountDeletionBody(request),{status:408});t.mock.timers.tick(5_000);await result;assert.equal(cancelled,true)
 const abort=new AbortController();abort.abort()
 await assert.rejects(lib.readAccountDeletionBody(new Request('https://cyntch.test/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:abort.signal})),{status:408})
})
test('a late identity lookup after timeout cannot resume deletion',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let resolveLookup,entered
 const started=new Promise(resolve=>{entered=resolve})
 const lib=load(async()=>{entered();return new Promise(resolve=>{resolveLookup=resolve})})
 const result=assert.rejects(lib.verifyAccountDeletionSuccessors(['user_parent']),{status:503,code:'account_deletion_verification_unavailable'})
 await started;t.mock.timers.tick(8_000);await result
 resolveLookup({data:[{id:'user_parent',banned:false,locked:false}]});await Promise.resolve()
})
