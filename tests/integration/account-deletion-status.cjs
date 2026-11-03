/* eslint-disable @typescript-eslint/no-require-imports -- Local production-server recovery check against an isolated PostgreSQL schema. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net')
const {fixture,connectionString}=require('../helpers/account-deletion.cjs')
const root=path.resolve(__dirname,'../..'),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))

test('production status HTTP works with no identity secret, stale credentials and erased account data',{
 skip:!connectionString||process.env.CYNTCH_DELETION_STATUS_HTTP_TEST!=='true',timeout:60_000,
},async t=>{
 const f=await fixture(t),schema=(await f.db.query('select current_schema() as name')).rows[0].name
 assert.match(schema,/^deletion_[a-f0-9]{32}$/)
 const intent=await f.intent();await f.accept(intent)
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve))
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve))
 const url=new URL(connectionString);url.searchParams.set('options','-c search_path='+schema)
 const log=path.join(os.tmpdir(),`cyntch-deletion-status-${intent.operationId}.log`),output=fs.openSync(log,'w')
 const server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{
  cwd:root,windowsHide:true,stdio:['ignore',output,output],env:{...process.env,NODE_ENV:'production',POSTGRES_URL:url.toString(),CLERK_SECRET_KEY:'',CLERK_JWT_KEY:''},
 })
 let spawnError;server.on('error',error=>{spawnError=error})
 const closed=new Promise(resolve=>server.once('close',resolve))
 const endpoint=`http://127.0.0.1:${port}/api/mobile/account-deletion/status`
 try{
  let ready=false
  for(let tries=0;tries<100;tries++){
   if(spawnError)throw spawnError
   if(server.exitCode!==null)throw new Error('Local production server exited; inspect '+log)
   try{const response=await fetch(endpoint,{signal:AbortSignal.timeout(500)});if(response.status===404){ready=true;break}}catch{/* Server is still starting. */}
   await pause(100)
  }
  assert.equal(ready,true,'Local production server did not become ready; inspect '+log)
  const {AccountDeletionStatusApi}=f.load(['mobile/src/services/account-deletion-status.ts'])
  const origin=`http://127.0.0.1:${port}`,client=new AccountDeletionStatusApi(origin,fetch,true)
  const recovery={origin,requestId:intent.operationId,secret:f.recoverySecret}
  const headers={'X-Cyntch-Deletion-Request':intent.operationId,'X-Cyntch-Deletion-Key':f.recoverySecret,
   Cookie:'__session=deliberately-invalid',Authorization:'Bearer deliberately-invalid'}
  const first=await fetch(endpoint,{headers,redirect:'error'}),pending=await first.json()
  assert.equal(first.status,200);assert.equal(pending.state,'pending');assert.equal(pending.requestId,intent.operationId)
  assert.equal(first.headers.get('cache-control'),'private, no-store');assert.equal(first.headers.get('set-cookie'),null)
  assert.equal(first.headers.get('x-clerk-auth-status'),null)
  assert.deepEqual(await client.read(recovery),pending)
  assert.equal((await fetch(endpoint,{method:'POST',headers})).status,405)
  const wrong=await fetch(endpoint,{headers:{...headers,'X-Cyntch-Deletion-Key':'0'.repeat(64)}})
  assert.equal(wrong.status,404);assert.equal((await wrong.json()).code,'account_deletion_status_unavailable')
  const processed=await f.lib.processAccountDeletions(f.db,{data:job=>f.lib.deleteAccountData(f.db,job),stripe:async()=>{},native:async()=>{},identity:async()=>{
   await f.db.query('update account_deletion_requests set apple_revocation_required=true')
  }},1)
  assert.equal(processed.completed,1);assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,0)
  const last=await fetch(endpoint,{headers,redirect:'error'}),done=await last.json()
  assert.equal(last.status,200);assert.equal(done.state,'completed');assert.equal(done.appleRevocationRequired,true)
  assert.deepEqual(await client.read(recovery),done)
  assert.deepEqual(Object.keys(done).sort(),['requestId','state','acceptedAt','completedAt','availableUntil','appleRevocationRequired'].sort())
  const tombstone=(await f.db.query('select account_id,work from account_deletion_requests')).rows[0]
  assert.deepEqual(tombstone,{account_id:null,work:{}})
  const evidence={verified:true,scope:'localhost isolated fixture only',identitySecretConfigured:false,
   staleCredentialsIgnored:true,pendingStatus:true,completedAfterDataErasure:true,manualAppleInstructionPreserved:true,destructiveMethodsRejected:true,clientRoundTrip:true,
   providerDeletion:'acknowledged test doubles; provider behavior is covered by separate adapter tests'}
  const evidencePath=log.replace(/\.log$/,'.json');fs.writeFileSync(evidencePath,JSON.stringify(evidence,null,2)+'\n')
  t.diagnostic('Evidence: '+evidencePath)
 }finally{
  if(server.exitCode===null)server.kill()
  await closed;fs.closeSync(output)
 }
})
