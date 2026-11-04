/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL deadline/cancellation checks. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto')
const {Pool}=require('pg'),{buildSync}=require('esbuild'),Module=require('node:module'),path=require('node:path')
const file=path.resolve(__dirname,'../lib/scheduler-deadline.ts'),loaded=new Module(file,module)
loaded._compile(buildSync({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text,file)
const {SchedulerDeadline,SchedulerDeadlineExceeded,schedulerTransaction}=loaded.exports
const connectionString=process.env.CYNTCH_TEST_DATABASE_URL,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))

test('response deadline rejects an unfinished provider operation without reporting success',async()=>{
 let finish,expired=0
 const pending=new Promise(resolve=>{finish=resolve}),start=performance.now()
 await assert.rejects(new SchedulerDeadline(100).run(()=>pending,()=>{expired++}),SchedulerDeadlineExceeded)
 assert.ok(performance.now()-start<1_000);assert.equal(expired,1)
 finish('late provider result');await pending
})

test('scheduler transactions commit normally, cancel stalled SQL and reject late work without leaking a connection',{
 skip:!connectionString,timeout:15_000,
},async t=>{
 const url=new URL(connectionString)
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.pathname==='/cyntch_mobile_test')
 const app=`scheduler_${randomUUID()}`,pool=new Pool({connectionString,max:1,application_name:app}),observer=new Pool({connectionString})
 // pg can report a server timeout during release via the pool error channel.
 // The application pool already handles this; keep the fixture equivalent.
 const poolErrors=[];pool.on('error',error=>poolErrors.push(error))
 t.after(async()=>{await pool.end();await observer.end()})
 // Temporary data belongs to this test's session; cancellation destroys it.
 const committed=await schedulerTransaction(pool,new SchedulerDeadline(2_000),async client=>{
  await client.query('create temporary table scheduler_fixture(value integer)')
  await client.query('insert into scheduler_fixture values(1)')
  return (await client.query('select sum(value)::int n from scheduler_fixture')).rows[0].n
 })
 assert.equal(committed,1)
 assert.equal((await pool.query('show statement_timeout')).rows[0].statement_timeout,'0','Transaction settings must not leak')
 assert.equal((await pool.query('show idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout,'0')
 let backend
 const start=performance.now()
 await assert.rejects(schedulerTransaction(pool,new SchedulerDeadline(300),async client=>{
  backend=(await client.query('select pg_backend_pid() id')).rows[0].id
  await client.query('insert into scheduler_fixture values(2)')
  await client.query('select pg_sleep(10)')
 }),error=>error instanceof SchedulerDeadlineExceeded||error.code==='57014')
 assert.ok(performance.now()-start<1_500,'Stalled SQL must not consume the external 30s timeout')
 for(let attempt=0;attempt<40;attempt++){
  if(!(await observer.query('select 1 from pg_stat_activity where pid=$1',[backend])).rowCount)break
  await pause(25)
 }
 assert.equal((await observer.query('select 1 from pg_stat_activity where pid=$1',[backend])).rowCount,0,'Canceled backend and transaction must be gone')
 assert.equal(pool.totalCount,0)

 // Saturated pool acquisition can complete after the caller has given up.
 const held=await pool.connect()
 await assert.rejects(schedulerTransaction(pool,new SchedulerDeadline(100),async()=>assert.fail('Late acquisition ran work')),SchedulerDeadlineExceeded)
 held.release();await pause(75)
 assert.equal(pool.totalCount,0,'Late acquired client must be discarded, not leaked')

 let resume,lateQuery
 const gate=new Promise(resolve=>{resume=resolve})
 await assert.rejects(schedulerTransaction(pool,new SchedulerDeadline(100),async client=>{
  await gate
  lateQuery=client.query('select 1')
  await lateQuery
 }),SchedulerDeadlineExceeded)
 resume();await pause(25)
 await assert.rejects(lateQuery,SchedulerDeadlineExceeded)
 assert.equal(pool.totalCount,0,'Provider callback must not reuse a released client')
 assert.equal(await schedulerTransaction(pool,new SchedulerDeadline(1_000),async client=>(await client.query('select 42 n')).rows[0].n),42,'Next tick can acquire a healthy connection')
 assert.ok(poolErrors.every(error=>error.code==='25P03'),'Only the deliberate idle-transaction timeout may reach the pool error channel')
})

test('many individually fast queries share one transaction deadline', {skip:!connectionString,timeout:5_000},async t=>{
 const url=new URL(connectionString)
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.pathname==='/cyntch_mobile_test')
 const pool=new Pool({connectionString,max:1});pool.on('error',()=>{});t.after(()=>pool.end())
 let queries=0
 await assert.rejects(schedulerTransaction(pool,new SchedulerDeadline(250),async client=>{
  for(let i=0;i<100;i++){await client.query('select pg_sleep(0.02)');queries++}
 }),error=>error instanceof SchedulerDeadlineExceeded||error.code==='57014')
 assert.ok(queries>0&&queries<30)
 assert.equal(pool.totalCount,0)
})
