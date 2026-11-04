/* eslint-disable @typescript-eslint/no-require-imports -- Real local HTTP scheduler, no external credentials or provider mutations. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net')
const {fixture,connectionString}=require('../helpers/account-deletion.cjs'),root=path.resolve(__dirname,'../..')
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))

test('production deletion worker survives unavailable Clerk and retains failed provider work',{
 skip:!connectionString||process.env.CYNTCH_DELETION_WORKER_HTTP_TEST!=='true',timeout:60_000,
},async t=>{
 const f=await fixture(t),schema=(await f.db.query('select current_schema() as name')).rows[0].name
 assert.match(schema,/^deletion_[a-f0-9]{32}$/)
 // A separate account with no households/purchases needs no Stripe or native
 // provider calls. Real identity erasure must stay pending without credentials.
 const accountId='user_worker_'+randomUUID(),scope={accountId,sessionId:'sess_worker_'+randomUUID(),deviceId:randomUUID()}
 await f.db.query("insert into users(id,full_name) values($1,'Isolated worker account')",[accountId])
 await f.db.query('insert into native_notification_installations(device_id,secret_hash) values($1,$2)',[scope.deviceId,createHash('sha256').update(f.secret).digest('hex')])
 await f.db.query("insert into native_notification_devices(user_id,device_id,platform,permission,session_id) values($1,$2,'android','denied',$3)",[accountId,scope.deviceId,scope.sessionId])
 const review=await f.lib.readAccountDeletionReview(scope,f.secret)
 const intent={operationId:randomUUID(),revision:review.revision,ownership:[],confirmAccountDeletion:true,acknowledgeSubscriptions:true}
 await f.lib.acceptAccountDeletion(f.db,scope,f.secret,intent,true,async ids=>assert.deepEqual(ids,[]),'https://fixture.clerk.accounts.dev',f.recoverySecret)
 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve))
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve))
 const url=new URL(connectionString);url.searchParams.set('options','-c search_path='+schema)
 const log=path.join(os.tmpdir(),`cyntch-deletion-worker-${intent.operationId}.log`),output=fs.openSync(log,'w')
 const server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{
  cwd:root,windowsHide:true,stdio:['ignore',output,output],env:{...process.env,NODE_ENV:'production',POSTGRES_URL:url.toString(),CRON_SECRET:'isolated-worker-secret',
   ACCOUNT_DELETION_PROCESSING_ENABLED:'true',ACCOUNT_DELETION_SUBMISSION_ENABLED:'false',NATIVE_BILLING_ENABLED:'false',NATIVE_PUSH_ENABLED:'false',
   CLERK_SECRET_KEY:'',CLERK_JWT_KEY:'',STRIPE_SECRET_KEY:'',REVENUECAT_SECRET_KEY:'',REVENUECAT_V2_SECRET_KEY:''},
 })
 let spawnError;server.on('error',error=>{spawnError=error});const closed=new Promise(resolve=>server.once('close',resolve))
 const endpoint=`http://127.0.0.1:${port}/api/internal/account-deletions`
 try{
  let ready=false
  for(let attempt=0;attempt<100;attempt++){
   if(spawnError)throw spawnError
   if(server.exitCode!==null)throw Error('Local server exited; inspect '+log)
   try{if((await fetch(endpoint,{signal:AbortSignal.timeout(500)})).status===401){ready=true;break}}catch{/* Starting local production server. */}
   await pause(100)
  }
  assert.equal(ready,true,'HTTP scheduler unavailable; inspect '+log)
  assert.equal((await f.db.query('select attempts from account_deletion_requests where id=$1',[intent.operationId])).rows[0].attempts,0)
  const headers={Authorization:'Bearer isolated-worker-secret',Cookie:'__session=deliberately-invalid'}
  const first=await fetch(endpoint,{headers,redirect:'error'}),body=await first.json()
  assert.equal(first.status,503);assert.equal(body.enabled,true);assert.equal(body.ok,false);assert.equal(body.claimed,1);assert.equal(body.failed,1)
  assert.equal(first.headers.get('cache-control'),'private, no-store');assert.equal(first.headers.get('x-clerk-auth-status'),null)
  assert.equal(JSON.stringify(body).includes(accountId),false);assert.equal(JSON.stringify(body).includes(f.recoverySecret),false)
  let row=(await f.db.query('select state,work,last_error_code,lease_id from account_deletion_requests where id=$1',[intent.operationId])).rows[0]
  assert.equal(row.state,'pending');assert.deepEqual(row.work.phases,{data:true,stripe:true,native:true,identity:false})
  assert.equal(row.last_error_code,'identity_cleanup_failed');assert.equal(row.lease_id,null)
  assert.equal((await f.db.query('select 1 from users where id=$1',[accountId])).rowCount,0)
  assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,1,'Unrelated fixture account preserved')
  // Force a future backoff to make the second visit deterministic.
  await f.db.query("update account_deletion_requests set next_attempt_at=now()+interval '1 hour' where id=$1",[intent.operationId])
  const again=await fetch(endpoint,{headers}),backoff=await again.json()
  assert.equal(again.status,503);assert.equal(backoff.claimed,0);assert.equal(backoff.failed,1)
  const status=await fetch(`http://127.0.0.1:${port}/api/mobile/account-deletion/status`,{
   headers:{'X-Cyntch-Deletion-Request':intent.operationId,'X-Cyntch-Deletion-Key':f.recoverySecret,...headers},
  })
  assert.equal(status.status,200);assert.equal((await status.json()).state,'pending')
  row=(await f.db.query('select work from account_deletion_requests where id=$1',[intent.operationId])).rows[0]
  assert.equal(row.work.identity.issuer,'https://fixture.clerk.accounts.dev')
  const evidence={verified:true,scope:'localhost isolated schema',cronSecretRequired:true,identityMiddlewareIndependent:true,
   realDataErasure:true,unrelatedAccountPreserved:true,pendingProviderWorkRetained:true,backoffReportsFailure:true,recoveryReceiptAvailable:true,
   externalCredentialsConfigured:false,providerDeletion:'not performed; missing identity configuration intentionally fails closed'}
  const evidencePath=log.replace(/\.log$/,'.json');fs.writeFileSync(evidencePath,JSON.stringify(evidence,null,2)+'\n');t.diagnostic('Evidence: '+evidencePath)
 }finally{
  if(server.exitCode===null)server.kill()
  await closed;fs.closeSync(output)
 }
})
