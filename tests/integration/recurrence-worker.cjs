/* eslint-disable @typescript-eslint/no-require-imports -- Real local HTTP scheduler and database; no external credentials or clients. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net')
const {fixture,connectionString}=require('../helpers/account-deletion.cjs'),root=path.resolve(__dirname,'../..')
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const loadRequested=process.env.CYNTCH_RECURRENCE_LOAD_TEST==='true'

test('the public cron endpoint advances closed-client tasks and recurrences, deduplicates events and reports partial failure',{
 skip:!connectionString||process.env.CYNTCH_RECURRENCE_HTTP_TEST!=='true',timeout:loadRequested?360_000:180_000,
},async t=>{
 const f=await fixture(t),schema=(await f.db.query('select current_schema() as name,current_database() as database,inet_server_port() as port')).rows[0]
 assert.match(schema.name,/^deletion_[a-f0-9]{32}$/)
 assert.equal(schema.database,'cyntch_mobile_test');assert.equal(schema.port,55439)
 // Use a real premium entitlement, with no payment-provider calls or owner bypass.
 await f.db.query("update household_billing set paid_through=now()+interval '1 day' where household_id=$1",[f.deleting])
 await f.db.query("update households set timezone='Australia/Sydney' where id=$1",[f.deleting])
 const timerRoutine=randomUUID(),timerRun=randomUUID(),timerTask=randomUUID(),routine=randomUUID(),oldRun=randomUUID(),oldTask=randomUUID()
 await f.db.query("insert into routines(id,household_id,name,type) values($1,$2,'Timer fixture','one_off')",[timerRoutine,f.deleting])
 await f.db.query("insert into routine_occurrences(id,household_id,routine_id,kind,title,scheduled_for) values($1,$2,$3,'routine','Timer fixture',now())",[timerRun,f.deleting,timerRoutine])
 await f.db.query("insert into tasks(id,household_id,routine_id,routine_occurrence_id,assignee_id,title,unlock_at,expires_at) values($1,$2,$3,$4,$5,'Timed fixture',now()+interval '1 hour',now()+interval '2 hours')",[timerTask,f.deleting,timerRoutine,timerRun,f.child])
 await f.db.query("insert into occurrence_tasks(occurrence_id,task_id,status) values($1,$2,'locked')",[timerRun,timerTask])
 const readTask=async()=> (await f.db.query('select status,completion_reason from occurrence_tasks where occurrence_id=$1 and task_id=$2',[timerRun,timerTask])).rows[0]
 const events=async()=> (await f.db.query('select id,kind,subject,member_ids from native_notification_events where household_id=$1 order by id',[f.deleting])).rows
 await f.db.query('delete from native_notification_events where household_id=$1',[f.deleting])

 const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve))
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve))
 const url=new URL(connectionString);url.searchParams.set('options','-c search_path='+schema.name)
 const log=path.join(os.tmpdir(),`cyntch-recurrence-worker-${randomUUID()}.log`),output=fs.openSync(log,'w')
 const buildRoot=path.resolve(process.env.CYNTCH_RECURRENCE_TEST_BUILD_ROOT||root)
 const server=spawn(process.execPath,[path.join(buildRoot,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{
  cwd:buildRoot,windowsHide:true,stdio:['ignore',output,output],env:{...process.env,NODE_ENV:'production',POSTGRES_URL:url.toString(),CRON_SECRET:'isolated-recurrence-secret',
   FREEMIUM_ENFORCEMENT_ENABLED:'true',ACCOUNT_DELETION_PROCESSING_ENABLED:'false',ACCOUNT_DELETION_SUBMISSION_ENABLED:'false',NATIVE_BILLING_ENABLED:'false',NATIVE_PUSH_ENABLED:'false',
   CLERK_SECRET_KEY:'',CLERK_JWT_KEY:'',STRIPE_SECRET_KEY:'',REVENUECAT_SECRET_KEY:'',REVENUECAT_V2_SECRET_KEY:'',EXPO_PUSH_ACCESS_TOKEN:'',
   WEB_PUSH_VAPID_PUBLIC_KEY:'',WEB_PUSH_VAPID_PRIVATE_KEY:'',WEB_PUSH_CONTACT_EMAIL:'',FIREBASE_SERVICE_ACCOUNT_JSON:'',FIREBASE_PROJECT_ID:'',FIREBASE_CLIENT_EMAIL:'',FIREBASE_PRIVATE_KEY:''},
 })
 let spawnError;server.on('error',error=>{spawnError=error});const closed=new Promise(resolve=>server.once('close',resolve))
 const endpoint=`http://127.0.0.1:${port}/api/cron`,headers={Authorization:'Bearer isolated-recurrence-secret',Cookie:'__session=deliberately-invalid'}
 const durations=[],lag={}
 const tick=async()=>{
  const started=performance.now(),response=await fetch(endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(30_000)})
  const body=await response.json();durations.push(Math.round(performance.now()-started))
  assert.equal(response.headers.get('cache-control'),'no-store')
  assert.equal(response.headers.get('x-clerk-auth-status'),null)
  return {response,body}
 }
 try{
  let ready=false
  for(let attempt=0;attempt<100;attempt++){
   if(spawnError)throw spawnError
   if(server.exitCode!==null)throw Error('Local server exited; inspect '+log)
   try{if((await fetch(endpoint,{signal:AbortSignal.timeout(500)})).status===401){ready=true;break}}catch{/* Local production server starting. */}
   await pause(100)
  }
  assert.equal(ready,true,'HTTP scheduler unavailable; inspect '+log)
  assert.equal((await readTask()).status,'locked');assert.deepEqual(await events(),[],'Unauthenticated visits did no work')
  let result=await tick();assert.equal(result.response.status,200);assert.equal(result.body.ok,true)
  assert.equal((await readTask()).status,'locked','A future activation must not unlock early')

  // Real wall-clock transitions, without a browser/mobile client or mocked Date.
  const dates=(await f.db.query("update tasks set unlock_at=clock_timestamp()+interval '2 seconds',expires_at=clock_timestamp()+interval '6 seconds' where id=$1 returning unlock_at,expires_at",[timerTask])).rows[0]
  await f.db.query(`create function cyntch_fixture_fail_usage() returns trigger language plpgsql as $$
    begin if new.household_id='${f.deleting}'::uuid then raise exception 'Isolated commit-boundary failure'; end if; return new; end $$;
    create trigger fixture_usage_failure before insert or update on household_usage_daily for each row execute function cyntch_fixture_fail_usage()`)
  await pause(Math.max(0,dates.unlock_at.getTime()-Date.now()+100))
  result=await tick();assert.equal(result.response.status,503);assert.equal(result.body.householdsFailed,1)
  assert.equal((await readTask()).status,'locked','Failed transaction must retain the old task state')
  assert.deepEqual(await events(),[],'Failed transaction must not publish its notification events')
  assert.equal(result.body.tasksUnlocked,0,'Health counters must not report rolled-back task changes as completed work')
  await f.db.query('drop trigger fixture_usage_failure on household_usage_daily;drop function cyntch_fixture_fail_usage()')
  result=await tick();assert.equal(result.response.status,200);assert.equal((await readTask()).status,'unlocked')
  lag.activationMs=Date.now()-dates.unlock_at.getTime()
  let observed=await events();assert.equal(observed.filter(event=>event.kind==='task_available').length,1)
  assert.deepEqual(observed.find(event=>event.kind==='task_available').member_ids,[f.child])
  await pause(Math.max(0,dates.expires_at.getTime()-Date.now()+100))
  result=await tick();assert.equal(result.response.status,200);assert.deepEqual(await readTask(),{status:'completed',completion_reason:'expiry'})
  lag.expiryMs=Date.now()-dates.expires_at.getTime()
  observed=await events();assert.equal(observed.filter(event=>event.kind==='task_completed_automatically').length,1)
  assert.equal(observed.filter(event=>event.kind==='routine_completed').length,1)
  const timerEvents=observed;await tick();assert.deepEqual(await events(),timerEvents,'Repeated scans cannot duplicate timer events')
  t.diagnostic('Real-time activation, automatic completion and event deduplication passed with no app client')

  const due=new Date(Math.ceil((Date.now()+5000)/60_000)*60_000)
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(due)
  const part=type=>parts.find(value=>value.type===type).value
  const rule={id:randomUUID(),frequency:'daily',interval:1,startDate:`${part('year')}-${part('month')}-${part('day')}`,time:`${part('hour')}:${part('minute')}`}
  await f.db.query("insert into routines(id,household_id,name,recurrence_rule,complete_older_occurrences_on_new) values($1,$2,'Scheduled fixture',$3,true)",[routine,f.deleting,JSON.stringify([rule])])
  await f.db.query("insert into tasks(household_id,routine_id,title,assignee_id) values($1,$2,'Generated fixture',$3)",[f.deleting,routine,f.child])
  await f.db.query("insert into routine_occurrences(id,household_id,routine_id,kind,title,scheduled_for) values($1,$2,$3,'routine','Older fixture',$4)",[oldRun,f.deleting,routine,new Date(due.getTime()-86_400_000)])
  await f.db.query("insert into tasks(id,household_id,routine_id,routine_occurrence_id,title,assignee_id) values($1,$2,$3,$4,'Older unfinished fixture',$5)",[oldTask,f.deleting,routine,oldRun,f.child])
  await f.db.query("insert into occurrence_tasks(occurrence_id,task_id,status) values($1,$2,'unlocked')",[oldRun,oldTask])
  await f.db.query('delete from native_notification_events where household_id=$1',[f.deleting])
  result=await tick();assert.equal(result.response.status,200)
  assert.equal((await f.db.query('select count(*)::int n from routine_occurrences where routine_id=$1',[routine])).rows[0].n,1,'Future recurrence must not generate early')
  await pause(Math.max(0,due.getTime()-Date.now()+100))
  result=await tick();assert.equal(result.response.status,200);assert.equal(result.body.ok,true)
  lag.recurrenceMs=Date.now()-due.getTime()
  const runs=(await f.db.query('select id,status,completion_reason,scheduled_for,created_via from routine_occurrences where routine_id=$1 order by scheduled_for',[routine])).rows
  assert.equal(runs.length,2);assert.equal(runs[0].completion_reason,'newer_copy');assert.equal(runs[0].status,'completed')
  assert.equal(runs[1].scheduled_for.toISOString(),due.toISOString());assert.equal(runs[1].created_via,'recurrence')
  observed=await events();assert.equal(observed.filter(event=>event.kind==='routine_generated').length,1)
  assert.equal(observed.filter(event=>event.kind==='routine_superseded').length,1)
  assert.equal(observed.filter(event=>event.kind==='routine_completed'||event.kind==='task_completed').length,0,'Replacement must not masquerade as task-driven completion')
  await tick();assert.deepEqual(await events(),observed,'Repeated scheduler calls cannot duplicate recurrence events')
  assert.equal((await f.db.query('select count(*)::int n from routine_occurrences where routine_id=$1',[routine])).rows[0].n,2)
  t.diagnostic('Real-time recurrence, newer-copy completion and distinct durable events passed')

  // A transaction failure in one household must be visible to a status-only
  // external scheduler while successful households retain their committed work.
  await f.db.query(`create function cyntch_fixture_fail_scheduler() returns trigger language plpgsql as $$
    begin if new.household_id='${f.shared}'::uuid then raise exception 'Isolated scheduler failure'; end if; return new; end $$;
    create trigger fixture_scheduler_failure before insert or update on household_billing for each row execute function cyntch_fixture_fail_scheduler()`)
  result=await tick();assert.equal(result.response.status,503);assert.equal(result.body.ok,false)
  assert.equal(result.body.householdsFailed,1);assert.equal(result.body.householdsProcessed,2)
  assert.equal(JSON.stringify(result.body).includes(f.shared),false,'Public health response contains no household identifier')
  assert.deepEqual(await events(),observed,'A partial failure must not undo or duplicate committed events')
  await f.db.query('drop trigger fixture_scheduler_failure on household_billing;drop function cyntch_fixture_fail_scheduler()')
  result=await tick();assert.equal(result.response.status,200);assert.equal(result.body.ok,true);assert.equal(result.body.householdsFailed,0)

  // A slow database statement must be canceled, roll back, and leave the next
  // tick free to retry. This is actual HTTP/SQL, not a mocked timer promise.
  await f.db.query(`create function cyntch_fixture_stall_scheduler() returns trigger language plpgsql as $$
    begin if new.household_id='${f.shared}'::uuid then perform pg_sleep(35); end if; return new; end $$;
    create trigger fixture_scheduler_stall before insert or update on household_billing for each row execute function cyntch_fixture_stall_scheduler()`)
  const lastChecked=(await f.db.query('select last_scheduled_check_at from household_billing where household_id=$1',[f.shared])).rows[0].last_scheduled_check_at
  result=await tick();assert.equal(result.response.status,503);assert.equal(result.body.householdsFailed,1)
  assert.ok(durations.at(-1)<10_000,'A 35s SQL stall must fail before the 30s external timeout')
  assert.deepEqual((await f.db.query('select last_scheduled_check_at from household_billing where household_id=$1',[f.shared])).rows[0].last_scheduled_check_at,lastChecked,'Interrupted work must roll back')
  assert.deepEqual(await events(),observed)
  await f.db.query('drop trigger fixture_scheduler_stall on household_billing;drop function cyntch_fixture_stall_scheduler()')
  result=await tick();assert.equal(result.response.status,200);assert.equal(result.body.ok,true)
  t.diagnostic('35-second SQL stall canceled; HTTP 503 within 10 seconds; rollback and retry verified')

  // Individually valid statements must still share the batch deadline. Six
  // households at 4.5s each exceed the recurrence budget even though each
  // statement is below its own timeout. Cancel only the in-flight transaction.
  for(let i=0;i<3;i++)await f.db.query("insert into households(id,name,leader_id) values($1,'Budget fixture',$2)",[randomUUID(),f.owner])
  await f.db.query(`create function cyntch_fixture_slow_batch() returns trigger language plpgsql as $$
    begin perform pg_sleep(4.5); return new; end $$;
    create trigger fixture_batch_delay after insert or update on household_billing for each row execute function cyntch_fixture_slow_batch()`)
  result=await tick();assert.equal(result.response.status,503);assert.equal(result.body.budgetExhausted,true)
  assert.ok(durations.at(-1)>=19_000&&durations.at(-1)<27_000,'Aggregate work must stop at the 20s batch deadline')
  assert.ok(result.body.householdsProcessed>0&&result.body.householdsProcessed<6)
  assert.deepEqual(await events(),observed,'Committed recurrence notifications survive an interrupted later household')
  await f.db.query('drop trigger fixture_batch_delay on household_billing;drop function cyntch_fixture_slow_batch()')
  result=await tick();assert.equal(result.response.status,200);assert.equal(result.body.householdsProcessed,6)
  t.diagnostic('Aggregate batch deadline, partial commits and next-tick recovery verified')
  const evidence={verified:true,scope:'production Next HTTP handler; localhost isolated PostgreSQL schema',client:'no browser or mobile client',
   authenticationRequired:true,realClock:true,timezone:'Australia/Sydney',activation:true,expiry:true,recurrence:true,supersededCompletion:true,
   notifications:'durable native events; no remote delivery attempted',rollbackRetainsState:true,committedCountersOnly:true,retryDeduplication:true,partialFailureStatus:503,recoveryStatus:200,stalledSqlCanceled:true,aggregateDeadline:true,
   lagMs:lag,requestDurationMs:durations,limitations:'Small isolated fixture; not a production scheduler cadence, p95/load, DST or physical push measurement'}
  const evidencePath=log.replace(/\.log$/,'.json');fs.writeFileSync(evidencePath,JSON.stringify(evidence,null,2)+'\n');t.diagnostic('Evidence: '+evidencePath)
  if(loadRequested){
   const loadPath=log.replace(/\.log$/,'-load.json')
   t.diagnostic('Controlled load evidence: '+loadPath)
   await require('../helpers/recurrence-load.cjs')(f,tick,loadPath)
  }
 }finally{
  if(server.exitCode===null)server.kill()
  await closed;fs.closeSync(output)
 }
})
