/* eslint-disable @typescript-eslint/no-require-imports -- Two independent SQLite devices and PostgreSQL completion receipts. */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { randomUUID } = require('node:crypto')
const { SqliteAdapter } = require('../helpers/mobile-sqlite.cjs')
const { fixture, connectionString } = require('../helpers/account-deletion.cjs')

// The packaged-server check also calls this scenario with actual HTTP/Clerk.
async function verifyReplay(f, board, taskId, transport) {
  const { LocalStore, SyncEngine } = f.load(['mobile/src/storage/local-store.ts', 'mobile/src/storage/sync-engine.ts'])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'cyntch-clock-replay-'))
  const base = Date.now()-60_000, task = board.tasks.find(task=>task.id===taskId), account = f.owner
  assert.equal(task.status,'unlocked')
  const householdId = board.household.id, occurrenceId = task.occurrence_id
  const attached=new Set()
  const device = async (id, skew, previous) => {
    const disk=new SqliteAdapter(path.join(dir,id+'.db')); attached.add(disk)
    const store=new LocalStore(disk); await store.initialize()
    if (!previous) await store.cacheBoard(account,board)
    const receipts=[], api=transport(id)
    const d={id,store,disk,clocks:0,skew,receipts,interrupt:null}
    d.engine=new SyncEngine(store,account,{
      serverTime:()=>{d.clocks++;return api.serverTime()},
      send:async change=>{const result=await api.send(change);receipts.push(result)
        if (change.id===d.interrupt) d.engine.stop() // Server has replied, SQLite has not acknowledged.
        return result},
    },()=>{},()=>Date.now()+d.skew)
    d.edit=async(completed,at)=>{const op=randomUUID();await store.enqueueCompletion({
      id:op,accountId:account,householdId,occurrenceId,taskId,deviceId:id,memberId:account,completed,deviceTimeMs:at+d.skew,
    });return op}
    d.close=()=>{d.engine.stop();disk.close();attached.delete(disk)}
    return d
  }
  const counters=async()=>({
    receipts:(await f.db.query('select operation_id from completion_operations where household_id=$1 order by operation_id',[householdId])).rows,
    events:(await f.db.query('select id,kind from native_notification_events where household_id=$1 order by id',[householdId])).rows,
  })
  try {
    const fast=await device(randomUUID(),8*3_600_000), slow=await device(randomUUID(),-3*3_600_000)
    const first=await slow.edit(true,base), older=await fast.edit(true,base+15_000), last=await slow.edit(false,base+30_000)
    assert.equal(fast.clocks+slow.clocks,0)
    slow.interrupt=last
    await slow.engine.flush()
    assert.deepEqual(slow.receipts.map(r=>[r.operationId,r.outcome]),[[first,'applied'],[last,'applied']])
    const pending=await slow.store.pending(account)
    assert.equal(pending.length,1);assert.equal(pending[0].id,last)
    assert.ok(Math.abs(pending[0].correctedTimeMs-(base+30_000))<2_000)
    const receipt=slow.receipts[1]; assert.equal(slow.clocks,1)
    slow.close()
    // The fast tablet had the older edit but is the last to connect.
    await fast.engine.flush()
    assert.deepEqual(fast.receipts.map(r=>[r.operationId,r.outcome]),[[older,'superseded']])
    assert.equal((await fast.store.pending(account)).length,0); assert.equal(fast.clocks,1)
    const before=await counters()
    assert.deepEqual(before.receipts.map(row=>row.operation_id),[first,older,last].sort())
    assert.equal(before.events.filter(row=>row.kind==='task_completed').length,1)
    assert.equal(before.events.filter(row=>row.kind==='task_reopened').length,1)
    const resumed=await device(slow.id,11*3_600_000,true)
    assert.equal((await resumed.store.pending(account))[0].correctedTimeMs,pending[0].correctedTimeMs)
    await resumed.engine.flush(); await resumed.engine.flush(); await fast.engine.flush()
    assert.equal(resumed.clocks,0,'retry retains the first correction even after changing the clock again')
    assert.equal(fast.clocks,1,'an empty queue does not sample time')
    assert.deepEqual(resumed.receipts,[receipt]); assert.deepEqual(await counters(),before)
    assert.equal((await resumed.store.pending(account)).length,0)
    for(const d of [fast,resumed]) assert.equal((await d.store.getBoard(account,householdId)).tasks.find(t=>t.id===taskId).status,'unlocked')
    const winner=(await f.db.query('select operation_id from completion_versions where task_id=$1 and occurrence_id=$2',[taskId,occurrenceId])).rows
    assert.deepEqual(winner,[{operation_id:last}])
    return {deviceClockOffsetsHours:[8,-3],clockAfterRestartHours:11,offlineEdits:3,timeSamples:2,
      retransmissions:1,extraEventsOnReplay:0,pendingAfterAcknowledgement:0,winner:'latest edit, not last device to reconnect'}
  } finally {
    for(const disk of attached)disk.close()
    assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true})
  }
}
module.exports={verifyReplay}

if(require.main===module) require('node:test').test('offline edits from fast and slow clocks converge after reverse-order delivery and a lost acknowledgement',
  {skip:!connectionString,timeout:25_000},async t=>{
    const f=await fixture(t),run=randomUUID(),task=randomUUID()
    await f.db.query("insert into routine_occurrences(id,household_id,kind,title,scheduled_for) values($1,$2,'manual','Clock check',now())",[run,f.transfer])
    for(const id of [task,randomUUID()]) {
      await f.db.query("insert into tasks(id,household_id,routine_occurrence_id,title) values($1,$2,$3,'Clock check')",[id,f.transfer,run])
      await f.db.query("insert into occurrence_tasks(occurrence_id,task_id,status) values($1,$2,'unlocked')",[run,id])
    }
    const mocks={'next/server':{NextResponse:{json:Response.json},after:()=>{}},'next/navigation':{redirect:()=>assert.fail('unexpected redirect')},
      '@/lib/push':{dispatchPushForNotificationIds:async()=>{}},'@/lib/user-sync':{ensureCurrentUserRecord:async()=>{}}}
    const get=f.load(['app/api/mobile/bootstrap/route.ts'],mocks).GET
    const post=f.load(['app/api/mobile/completions/route.ts'],mocks).POST
    const time=f.load(['app/api/mobile/time/route.ts'],mocks).GET
    const headers={'X-Task-Save-User':f.owner,'X-Cyntch-Session':f.scope.sessionId,'Content-Type':'application/json'}
    const response=await get(new Request('https://fixture.test/api/mobile/bootstrap?householdId='+f.transfer,{headers}))
    assert.equal(response.status,200)
    const result=await verifyReplay(f,(await response.json()).board,task,deviceId=>({
      serverTime:async()=>(await (await time()).json()).serverTimeMs,
      send:async change=>{const res=await post(new Request('https://fixture.test/api/mobile/completions',{method:'POST',headers:{...headers,'X-Cyntch-Device':deviceId},
        body:JSON.stringify({action:'setOccurrenceTaskCompleted',householdId:f.transfer,occurrenceId:run,taskId:task,actorMemberId:f.owner,completed:change.completed,
          clientOperation:{id:change.id,deviceId,sequence:change.sequence,correctedTimeMs:change.correctedTimeMs}})}))
        assert.equal(res.status,200);return res.json()},
    }))
    t.diagnostic(JSON.stringify(result))
  })
