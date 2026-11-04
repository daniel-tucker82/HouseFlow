/* eslint-disable @typescript-eslint/no-require-imports -- Authenticated scheduler wiring and real durable deletion recovery. */
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module'),{buildSync}=require('esbuild')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),root=path.resolve(__dirname,'..')
function load(files,mocks={}){const loaded=new Module(__filename,module);loaded.require=name=>mocks[name]??require(name);loaded._compile(buildSync({stdin:{contents:files.map(file=>`export * from ${JSON.stringify(path.join(root,file))}`).join(';'),resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:Object.keys(mocks)}).outputFiles[0].text,__filename);return loaded.exports}
function environment(t,values){const old={};for(const [name,value] of Object.entries(values)){old[name]=process.env[name];if(value===undefined)delete process.env[name];else process.env[name]=value}t.after(()=>{for(const [name,value] of Object.entries(old)){if(value===undefined)delete process.env[name];else process.env[name]=value}})}
const cron=()=>new Request('http://localhost/api/internal/account-deletions',{headers:{authorization:'Bearer fixture-cron'}})

test('disabled processing makes no database/provider call, independently of submission and purchase flags',async t=>{
 environment(t,{ACCOUNT_DELETION_PROCESSING_ENABLED:'false',ACCOUNT_DELETION_SUBMISSION_ENABLED:'true',NATIVE_BILLING_ENABLED:'true'})
 const api=load(['lib/run-account-deletions.ts'],{'@/lib/db':{db:new Proxy({},{get(){assert.fail('Disabled worker accessed database')}})},
  '@/lib/account-deletion-processing':{processAccountDeletions:async()=>assert.fail('Disabled worker started')}})
 assert.deepEqual(await api.runAccountDeletions(),{enabled:false,ok:true})
})

test('runner wires every real phase boundary with its remaining time and sanitizes failures',async t=>{
 environment(t,{ACCOUNT_DELETION_PROCESSING_ENABLED:'true',ACCOUNT_DELETION_SUBMISSION_ENABLED:'false',NATIVE_BILLING_ENABLED:'false'})
 const calls=[],job={id:'private-job'},db={query:async()=>({rows:[{pending:0,failed:0}]})}
 let fail=false
 const api=load(['lib/run-account-deletions.ts'],{
  '@/lib/db':{db},'@/lib/account-deletion-processing':{processAccountDeletions:async(pool,adapters,maximum,budget)=>{
   assert.equal(pool,db);assert.equal(maximum,5);assert.equal(budget,20_000)
   if(fail)throw Error('private_token=do-not-expose')
   for(const [phase,time] of [['data',20_000],['stripe',16_000],['native',10_000],['identity',2_000]])await adapters[phase](job,time)
   return {claimed:1,completed:1,retrying:0,interrupted:0}
  }},
  '@/lib/account-deletion-data':{deleteAccountData:async(...args)=>calls.push(['data',...args])},
  '@/lib/account-deletion-stripe':{deleteAccountStripeData:async(...args)=>calls.push(['stripe',...args])},
  '@/lib/account-deletion-native':{deleteAccountNativeData:async(...args)=>calls.push(['native',...args])},
  '@/lib/account-deletion-identity':{deleteAccountIdentity:async(...args)=>calls.push(['identity',...args])},
 })
 assert.equal((await api.runAccountDeletions()).ok,true)
 assert.deepEqual(calls,[['data',db,job,20_000],['stripe',db,job,undefined,16_000],['native',db,job,undefined,10_000],['identity',db,job,undefined,2_000]])
 fail=true;assert.deepEqual(await api.runAccountDeletions(),{enabled:true,ok:false,error:'Account deletion processing needs retry'})
})

test('accepted deletion resumes across scheduler visits and failure backoff remains unhealthy', {skip:!connectionString},async t=>{
 environment(t,{ACCOUNT_DELETION_PROCESSING_ENABLED:'true',ACCOUNT_DELETION_SUBMISSION_ENABLED:'false',NATIVE_BILLING_ENABLED:'false'})
 const f=await fixture(t);await f.accept(await f.intent());const calls=[];let mode='pending',api
 const adapters={
  '@/lib/account-deletion-stripe':{deleteAccountStripeData:async()=>calls.push('stripe')},
  '@/lib/account-deletion-native':{deleteAccountNativeData:async()=>{calls.push('native');if(mode==='pending')throw new api.AccountDeletionDeferred(5)}},
  '@/lib/account-deletion-identity':{deleteAccountIdentity:async()=>{calls.push('identity');if(mode==='failing')throw Error('private provider response')}},
 }
 const fresh=()=>f.load(['lib/run-account-deletions.ts','lib/account-deletion-processing.ts'],adapters)
 api=fresh();let result=await api.runAccountDeletions()
 assert.equal(result.ok,true);assert.equal(result.pending,1);assert.equal(result.failed,0);assert.equal(result.retrying,1)
 assert.equal((await f.db.query('select 1 from users where id=$1',[f.owner])).rowCount,0,'Actual data adapter ran')
 result=await api.runAccountDeletions();assert.equal(result.claimed,0);assert.equal(result.ok,true)
 mode='failing';await f.db.query('update account_deletion_requests set next_attempt_at=now()')
 result=await api.runAccountDeletions();assert.equal(result.ok,false);assert.equal(result.failed,1)
 result=await api.runAccountDeletions();assert.equal(result.claimed,0);assert.equal(result.ok,false,'Backoff is not a recovery')
 mode='done';api=fresh();await f.db.query('update account_deletion_requests set next_attempt_at=now()')
 result=await api.runAccountDeletions();assert.equal(result.ok,true);assert.equal(result.completed,1);assert.equal(result.pending,0)
 assert.deepEqual(calls,['stripe','native','native','identity','identity'])
 const row=(await f.db.query('select state,account_id,work from account_deletion_requests')).rows[0]
 assert.equal(row.state,'completed');assert.equal(row.account_id,null);assert.deepEqual(row.work,{})
})

test('dedicated deletion scheduler requires the cron secret and reports application failures',async t=>{
 environment(t,{CRON_SECRET:'fixture-cron'});let calls=0,ok=false
 const {GET}=load(['app/api/internal/account-deletions/route.ts'],{'@/lib/run-account-deletions':{runAccountDeletions:async()=>{calls++;return {enabled:true,ok}}}})
 for(const value of [undefined,'fixture-cron','Bearer wrong','Bearer fixture-cron-extra']){
  const response=await GET(new Request('http://localhost/api/internal/account-deletions',{headers:value?{authorization:value}:{}}))
  assert.equal(response.status,401);assert.match(response.headers.get('cache-control'),/no-store/)
 }
 assert.equal(calls,0);assert.equal((await GET(cron())).status,503)
 ok=true;assert.equal((await GET(cron())).status,200)
 delete process.env.CRON_SECRET;assert.equal((await GET(cron())).status,503);assert.equal(calls,2)
})

test('household scheduler starts durable deletion work after authentication and retains it on early exit',async t=>{
 environment(t,{CRON_SECRET:'fixture-cron',ACCOUNT_DELETION_PROCESSING_ENABLED:'true',NATIVE_BILLING_ENABLED:'false',NATIVE_PUSH_ENABLED:'false',STRIPE_SECRET_KEY:undefined})
 const callbacks=[];let calls=0,failRecurrence=false
 const {GET}=load(['app/api/internal/recurrence/route.ts'],{
  'next/server':{NextResponse:{json:Response.json},after:callback=>callbacks.push(callback)},'@clerk/nextjs/server':{},
  '@/lib/push':{dispatchPushForNotificationIds:async()=>{}},'@/lib/stripe-billing':{},
  '@/lib/db':{db:{connect:async()=>Object.assign(new (require('node:events').EventEmitter)(),{
   query:async()=>{assert.equal(calls>0,true);if(failRecurrence)throw Error('Recurrence unavailable');return {rowCount:1,rows:[]}},release(){},
  })}},
  '@/lib/run-account-deletions':{runAccountDeletions:async()=>{calls++;return {enabled:true,ok:false,pending:1,failed:1}}},
 })
 assert.equal((await GET(new Request('http://localhost/api/cron'))).status,401);assert.equal(calls,0)
 const response=await GET(cron()),body=await response.json();assert.equal(response.status,503);assert.equal(body.ok,false);assert.equal(body.accountDeletions.failed,1)
 assert.equal(callbacks.length,2);await Promise.all(callbacks.map(callback=>callback()));assert.equal(calls,1,'after retains the same batch, not a second run')
 failRecurrence=true;const failed=await GET(cron());assert.equal(failed.status,503);assert.equal((await failed.json()).ok,false)
 assert.equal(callbacks.length,4);await Promise.all(callbacks.slice(2).map(callback=>callback()));assert.equal(calls,2)
})
