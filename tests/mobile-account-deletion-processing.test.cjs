/* eslint-disable @typescript-eslint/no-require-imports -- Durable phase acknowledgements and real lease/retry recovery. */
const {test}=require('node:test'),assert=require('node:assert/strict')
const {fixture,connectionString}=require('./helpers/account-deletion.cjs'),options={skip:!connectionString}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve}}
function adapters(calls,overrides={}){return Object.fromEntries(['data','stripe','native','identity'].map(phase=>[phase,overrides[phase]??(async job=>{calls.push([phase,job.id])})]))}
test('durable deletion phases resume after failure and clear personal work only after every phase is acknowledged',options,async t=>{
 const f=await fixture(t),intent=await f.intent();await f.accept(intent)
 const calls=[],first=await f.lib.processAccountDeletions(f.db,adapters(calls,{stripe:async()=>{throw new f.lib.AccountDeletionProcessingError('stripe_cleanup_failed')}}))
 assert.deepEqual(first,{claimed:1,completed:0,retrying:1,interrupted:0})
 let row=(await f.db.query('select * from account_deletion_requests')).rows[0]
 assert.deepEqual(row.work.phases,{data:true,stripe:false,native:false,identity:false});assert.equal(row.last_error_code,'stripe_cleanup_failed')
 assert.equal(row.account_id,f.owner);assert.equal(row.completed_at,null);assert.equal(row.lease_id,null)
 assert.equal((await f.lib.processAccountDeletions(f.db,adapters(calls))).claimed,0,'Respect durable retry delay')
 await f.db.query("update account_deletion_requests set next_attempt_at=now()-interval '1 second'")
 const resumed=await f.lib.processAccountDeletions(f.db,adapters(calls))
 assert.equal(resumed.completed,1);assert.deepEqual(calls.map(call=>call[0]),['data','stripe','native','identity'])
 row=(await f.db.query('select * from account_deletion_requests')).rows[0]
 assert.equal(row.state,'completed');assert.equal(row.account_id,null);assert.deepEqual(row.work,{})
 assert.equal(row.next_attempt_at,null);assert.equal(row.lease_id,null);assert.equal(row.last_error_code,null)
 assert.ok(row.completed_at);assert.equal(row.account_hash,f.lib.accountHash(f.owner))
 await assert.rejects(f.lib.assertAccountActive(f.db,f.owner),{status:410})
 assert.equal((await f.lib.processAccountDeletions(f.db,adapters(calls))).claimed,0)
})
test('another worker cannot claim an active lease and a stale worker cannot acknowledge an expired lease',options,async t=>{
 const f=await fixture(t);await f.accept(await f.intent())
 const entered=deferred(),release=deferred(),calls=[]
 const old=f.lib.processAccountDeletions(f.db,adapters(calls,{data:async()=>{entered.resolve();await release.promise}}),1)
 await entered.promise
 try{
  assert.equal((await f.lib.processAccountDeletions(f.db,adapters(calls),1)).claimed,0)
  await f.db.query("update account_deletion_requests set lease_until=now()-interval '1 second'")
  assert.equal((await f.lib.processAccountDeletions(f.db,adapters(calls),1)).completed,1)
 }finally{release.resolve()}
 assert.deepEqual(await old,{claimed:1,completed:0,retrying:0,interrupted:1})
 assert.deepEqual(calls.map(call=>call[0]),['data','stripe','native','identity'])
 assert.equal((await f.db.query('select state from account_deletion_requests')).rows[0].state,'completed')
})
test('lost phase acknowledgements safely repeat the same job ID and do not expose provider error details',options,async t=>{
 const f=await fixture(t);await f.accept(await f.intent())
 const calls=[],effects=new Set()
 const failed=await f.lib.processAccountDeletions(f.db,adapters(calls,{stripe:async job=>{
  effects.add(job.id)
  throw new Error('Provider accepted then acknowledgement lost: private_token=do-not-store')
 }}),1)
 assert.equal(failed.retrying,1)
 const row=(await f.db.query('select * from account_deletion_requests')).rows[0]
 assert.equal(row.last_error_code,'cleanup_failed');assert.equal(JSON.stringify(row).includes('do-not-store'),false)
 await f.db.query("update account_deletion_requests set next_attempt_at=now()-interval '1 second'")
 const done=await f.lib.processAccountDeletions(f.db,adapters(calls,{stripe:async job=>{assert.ok(effects.has(job.id));effects.add(job.id)}}),1)
 assert.equal(done.completed,1);assert.equal(effects.size,1)
})
test('processing yields at a phase boundary when its time budget is spent',options,async t=>{
 const f=await fixture(t);await f.accept(await f.intent())
 let now=0;const calls=[]
 const first=await f.lib.processAccountDeletions(f.db,adapters(calls,{data:async()=>{calls.push(['data']);now=100}}),5,50,()=>now)
 assert.deepEqual(first,{claimed:1,completed:0,retrying:0,interrupted:1})
 const pending=(await f.db.query('select lease_id,work from account_deletion_requests')).rows[0]
 assert.equal(pending.lease_id,null);assert.equal(pending.work.phases.data,true)
 assert.equal((await f.lib.processAccountDeletions(f.db,adapters(calls))).completed,1)
 assert.deepEqual(calls.map(call=>call[0]),['data','stripe','native','identity'])
})
