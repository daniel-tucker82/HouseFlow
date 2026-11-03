/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL device locks and route admission. */
const { test } = require('node:test'), assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { buildSync, transformSync } = require('esbuild'), { Pool } = require('pg')
const url = process.env.CYNTCH_TEST_DATABASE_URL, root = path.resolve(__dirname, '..')
function bundle(files, mocks) {
  const loaded = new Module(__filename, module); loaded.require = name => mocks[name] ?? require(name)
  loaded._compile(buildSync({ stdin: { contents: files.map(file => `export * from ${JSON.stringify(path.join(root, file))}`).join(';'), resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: Object.keys(mocks) }).outputFiles[0].text, __filename)
  return loaded.exports
}
async function fixture(t) {
  const destination = new URL(url)
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(destination.hostname) && destination.pathname === '/cyntch_mobile_test')
  const schema = `native_kiosk_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`create schema ${schema}`)
  const options = { connectionString: url, options: `-c search_path=${schema}`, application_name: schema }
  const db = new Pool({ ...options, max: 5 }), gate = new Pool({ ...options, max: 2 })
  t.after(async () => { await Promise.all([db.end(), gate.end()]); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  for (const name of ['app_role','routine_type','task_status','occurrence_status','notification_kind']) {
    const labels = (await admin.query(`select e.enumlabel from pg_enum e join pg_type p on p.oid=e.enumtypid join pg_namespace n on n.oid=p.typnamespace
      where p.typname=$1 and n.nspname='public' order by e.enumsortorder`, [name])).rows
    if (labels.length) await db.query(`create type ${name} as enum (${labels.map(row => "'" + row.enumlabel.replaceAll("'", "''") + "'").join(',')})`)
  }
  const directory = path.join(root, 'database')
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(directory, name), 'utf8'))
  await db.query(fs.readFileSync(path.join(directory, '0028_native_kiosk_sessions.sql'), 'utf8'))
  const householdId = randomUUID(), other = randomUUID(), occurrenceId = randomUUID(), taskId = randomUUID(), hiddenTask = randomUUID()
  await db.query("insert into users(id,full_name) values('parent','Parent'),('child','Alex'),('hidden','Hidden member'),('outsider','Other')")
  await db.query("insert into households(id,name,leader_id) values($1,'Family','parent'),($2,'Other family','parent')", [householdId, other])
  await db.query("insert into household_members(household_id,user_id,role) values($1,'parent','manager'),($1,'child','member'),($1,'hidden','member'),($2,'parent','manager')", [householdId, other])
  await db.query("insert into routine_occurrences(id,household_id,kind,title,scheduled_for) values($1,$2,'manual','Today',now())", [occurrenceId, householdId])
  for (const [task, member] of [[taskId,'child'],[hiddenTask,'hidden']]) {
    await db.query("insert into tasks(id,household_id,routine_occurrence_id,title,assignee_id) values($1,$2,$3,$4,$5)", [task, householdId, occurrenceId, member+' task', member])
    await db.query('insert into task_assignees(task_id,user_id) values($1,$2) on conflict do nothing', [task, member])
    await db.query("insert into occurrence_tasks(occurrence_id,task_id,status) values($1,$2,'unlocked')", [occurrenceId, task])
  }
  const auth = { userId: 'parent', sessionId: 'sess_tablet' }
  const mocks = { '@/lib/db': { db, kioskGateDb: gate }, '@clerk/nextjs/server': { auth: async () => auth } }
  const lib = bundle(['lib/native-kiosk-store.ts','lib/native-kiosk-guard.ts','lib/native-notification-outbox.ts','shared/mobile/kiosk.ts','shared/mobile/notification-catalog.ts'], mocks)
  const deviceId = randomUUID(), secret = 'a'.repeat(64), exitSecret = 'b'.repeat(64)
  const activation = (values = {}) => ({ action: 'activate', id: randomUUID(), householdId, visibleMemberIds: ['child'], editableMemberIds: ['child'], exitSecret, ...values })
  const save = (operation, values = {}) => lib.saveNativeKiosk(db, values.userId ?? auth.userId, values.sessionId ?? auth.sessionId, values.deviceId ?? deviceId, values.secret ?? secret, operation)
  const request = (pathname, body, headers = {}) => new Request(`http://localhost${pathname}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const guard = (request, handler = async () => Response.json({ ok: true }), values = {}) => lib.guardNativeKioskRequest(gate, request, values.userId ?? auth.userId, values.sessionId ?? auth.sessionId, handler)
  return { db, gate, admin, schema, householdId, other, occurrenceId, taskId, hiddenTask, deviceId, secret, exitSecret, activation, save, request, guard, lib, auth, mocks }
}
async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!await predicate()) { if (Date.now() > deadline) assert.fail('Timed out waiting for the database boundary'); await new Promise(resolve => setTimeout(resolve, 10)) }
}

test('K01 native kiosks isolate devices, replay activation/unlock safely and retain only hashed capabilities', { skip: !url }, async t => {
  const f = await fixture(t), first = f.activation(), secondDevice = randomUUID(), second = f.activation()
  const saved = await Promise.all([f.save(first), f.save(first)])
  assert.deepEqual(saved[0], saved[1]); assert.equal((await f.db.query('select count(*)::int as n from native_kiosk_sessions')).rows[0].n, 1)
  assert.ok(!JSON.stringify(saved).includes(f.exitSecret)); assert.ok(!JSON.stringify(saved).includes('exit_secret_hash'))
  await f.save(second, { deviceId: secondDevice, sessionId: 'sess_other_tablet' })
  assert.equal((await f.guard(f.request('/api/leader/flow'), undefined, { sessionId: 'sess_parent_phone' })).status, 200)
  await assert.rejects(f.save(f.activation()), error => error.status === 423)
  await assert.rejects(f.save({ ...first, editableMemberIds: [] }), error => error.status === 409)
  await assert.rejects(f.save({ action: 'unlock', id: first.id, exitSecret: 'c'.repeat(64) }), error => error.status === 403)
  await assert.rejects(f.save({ action: 'unlock', id: first.id, exitSecret: f.exitSecret }, { secret: 'd'.repeat(64) }), error => error.status === 403)
  const unlocked = await f.save({ action: 'unlock', id: first.id, exitSecret: f.exitSecret })
  assert.equal(unlocked.kiosk.state, 'unlocked')
  assert.deepEqual(await f.save(first), unlocked, 'late activation cannot relock an already unlocked operation')
  assert.deepEqual(await f.save({ action: 'unlock', id: first.id, exitSecret: f.exitSecret }), unlocked)
  assert.equal((await f.db.query('select state from native_kiosk_sessions where id=$1', [second.id])).rows[0].state, 'locked')
  assert.equal((await f.save(f.activation())).kiosk.state, 'locked')
})

test('K03 server restrictions ignore missing/spoofed flags and expose only permitted members/tasks', { skip: !url }, async t => {
  const f = await fixture(t); await f.save(f.activation())
  for (const [pathname, body] of [['/api/leader/flow'], ['/api/leader/flow',{action:'createHousehold', name:'Escape'}],
    ['/api/mobile/runs'], ['/api/mobile/join',{code:'invite'}], ['/api/mobile/notifications'], ['/api/billing/checkout',{interval:'yearly'}]]) {
    await assert.rejects(f.guard(f.request(pathname, body, { 'X-Cyntch-Kiosk': 'false', 'X-Cyntch-Device': randomUUID() }), async () => assert.fail('Restricted handler executed')), error => error.status === 423)
  }
  const snapshot = { household: { id: f.householdId, role: 'manager' }, members: [{id:'child'}, {id:'hidden'}], tasks: [
    { id: f.taskId, assignee_ids:['child','hidden'], blocking_task_title:'Private prerequisite', blocking_task_id:f.hiddenTask, blocking_task_assignee_ids:['hidden'] }, { id:f.hiddenTask, assignee_ids:['hidden'] } ] }
  const result = await f.guard(f.request('/api/mobile/bootstrap'), async request => {
    assert.equal(new URL(request.url).searchParams.get('householdId'), f.householdId)
    return Response.json({ accountId:'parent', households:[snapshot.household,{id:f.other}], board:snapshot })
  })
  const data = await result.json()
  assert.equal(data.households.length,1); assert.deepEqual(data.board.members,[{id:'child'}]); assert.equal(data.board.tasks.length,1)
  assert.deepEqual(data.board.tasks[0].assignee_ids,['child']); assert.equal(data.board.tasks[0].blocking_task_title,null)
  assert.equal(data.board.tasks[0].blocking_task_id,null); assert.deepEqual(data.board.tasks[0].blocking_task_assignee_ids,[])
  await assert.rejects(f.guard(f.request('/api/mobile/bootstrap?householdId='+f.other)), error=>error.status===423)
  const change = { action:'setOccurrenceTaskCompleted', householdId:f.householdId, occurrenceId:f.occurrenceId, taskId:f.taskId,
    actorMemberId:'child', completed:true, clientOperation:{deviceId:f.deviceId} }
  const completed = await f.guard(f.request('/api/mobile/completions',change), async request => {
    await request.json() // Response filtering must not reread a consumed request.
    return Response.json({outcome:'applied', occurrenceTaskStatuses:[{task_id:f.taskId,status:'completed'},{task_id:f.hiddenTask,status:'unlocked'}]})
  })
  assert.deepEqual((await completed.json()).occurrenceTaskStatuses,[{task_id:f.taskId,status:'completed'}])
  for (const patch of [{actorMemberId:'hidden'}, {taskId:f.hiddenTask}, {householdId:f.other}, {clientOperation:{deviceId:randomUUID()}}]) {
    await assert.rejects(f.guard(f.request('/api/mobile/completions',{...change,...patch})), error=>[403,423].includes(error.status))
  }
  await f.db.query("update household_members set role='supervisor' where household_id=$1 and user_id='parent'", [f.householdId])
  await assert.rejects(f.guard(f.request('/api/mobile/bootstrap')), error=>error.status===423&&error.code==='kiosk_access_changed')
  const denied=await f.lib.withNativeKioskRequest(f.request('/api/mobile/bootstrap'),async()=>assert.fail('Removed manager reached bootstrap'))
  assert.equal(denied.status,423); assert.equal((await denied.json()).code,'kiosk_access_changed')
  const replaced=await f.lib.withNativeKioskRequest(f.request('/api/mobile/bootstrap',undefined,{'X-Cyntch-Session':'sess_other'}),async()=>assert.fail('Wrong session reached bootstrap'))
  assert.equal(replaced.status,403)
})

test('K04 recovery requires a different parent session, retires the old one, and does not unlock a second device', { skip: !url }, async t => {
  const f = await fixture(t), first = f.activation(), other = f.activation(), otherDevice = randomUUID()
  await f.save(first); await f.save(other,{deviceId:otherDevice,sessionId:'sess_second'})
  const recovery = {action:'recover',id:first.id,previousSessionId:f.auth.sessionId}
  await assert.rejects(f.save(recovery),error=>error.status===403)
  await assert.rejects(f.save(recovery,{userId:'child',sessionId:'sess_child'}),error=>error.status===403)
  await assert.rejects(f.guard(f.request('/api/leader/flow',undefined,{'X-Cyntch-Device':f.deviceId}),undefined,{sessionId:'sess_reauthenticated'}),error=>error.status===423)
  const recovered = await f.save(recovery,{sessionId:'sess_reauthenticated'})
  assert.equal(recovered.kiosk.state,'recovered')
  assert.deepEqual(await f.save(recovery,{sessionId:'sess_reauthenticated'}),recovered)
  await assert.rejects(f.guard(f.request('/api/leader/flow')),error=>error.status===401)
  await assert.rejects(f.save(f.activation()),error=>error.status===401)
  await assert.rejects(f.save(first),error=>error.status===401)
  await assert.rejects(f.lib.readNativeKiosk(f.db,'parent','sess_tablet',f.deviceId,f.secret),error=>error.status===401)
  assert.equal((await f.guard(f.request('/api/leader/flow'),undefined,{sessionId:'sess_reauthenticated'})).status,200)
  assert.equal((await f.db.query('select state from native_kiosk_sessions where id=$1',[other.id])).rows[0].state,'locked')
})

test('K04 recovery records an unreceived activation and prevents late activation or old-session access', { skip: !url }, async t => {
  const f=await fixture(t), activation=f.activation(), parent={sessionId:'sess_recovered_parent'}
  const operation={action:'recover',id:activation.id,previousSessionId:f.auth.sessionId}
  const recovered=await f.save(operation,parent)
  assert.equal(recovered.kiosk,null)
  assert.deepEqual(recovered.recovery,{id:activation.id,accountId:'parent',deviceId:f.deviceId,sessionId:f.auth.sessionId})
  assert.deepEqual(await f.save(operation,parent),recovered,'lost recovery replies replay the durable receipt')
  await assert.rejects(f.save(activation),error=>error.status===401)
  await assert.rejects(f.save(f.activation()),error=>error.status===401)
  await assert.rejects(f.guard(f.request('/api/leader/flow')),error=>error.status===401)
  await assert.rejects(f.lib.readNativeKiosk(f.db,'parent',f.auth.sessionId,f.deviceId,f.secret),error=>error.status===401)
  assert.equal((await f.guard(f.request('/api/leader/flow'),undefined,parent)).status,200)
  await assert.rejects(f.save(activation,parent),error=>error.status===409,'a new sign-in cannot reuse the cancelled activation ID')
  const newer=f.activation()
  await f.save(newer,parent)
  await assert.rejects(f.save(operation,{sessionId:'sess_newer_recovery'}),error=>error.status===409,'an old receipt must not unlock a newer kiosk')
  assert.equal((await f.db.query('select state from native_kiosk_sessions where id=$1',[newer.id])).rows[0].state,'locked')
})

test('K04 PIN unlock cancels unreceived activation without retiring parent access and wins a concurrent activation', { skip: !url }, async t => {
  const f=await fixture(t), first=f.activation(), unlock={action:'unlock',id:first.id,exitSecret:f.exitSecret}
  const result=await f.save(unlock)
  assert.equal(result.kiosk,null)
  assert.deepEqual(result.cancelledActivation,{id:first.id,accountId:'parent',deviceId:f.deviceId,sessionId:f.auth.sessionId})
  assert.deepEqual(await f.save(unlock),result)
  await assert.rejects(f.save({...unlock,exitSecret:'d'.repeat(64)}),error=>error.status===403)
  await assert.rejects(f.save(first),error=>error.status===409)
  assert.equal((await f.guard(f.request('/api/leader/flow'))).status,200)
  const next=f.activation()
  const concurrent=await Promise.allSettled([f.save(next),f.save({...unlock,id:next.id})])
  assert.equal(concurrent[1].status,'fulfilled')
  if(concurrent[0].status==='rejected') assert.equal(concurrent[0].reason.status,409)
  assert.equal((await f.db.query("select count(*)::int n from native_kiosk_sessions where state='locked'")).rows[0].n,0)
  assert.equal((await f.guard(f.request('/api/leader/flow'))).status,200)
  assert.equal((await f.save(f.activation())).kiosk.state,'locked','a fresh activation remains available on the same parent session')
})

test('K04 concurrent activation/recovery has one final recovered outcome; failed recovery rolls back its receipt', { skip: !url }, async t => {
  const f=await fixture(t), activation=f.activation(), parent={sessionId:'sess_recovered_parent'}
  const recovery={action:'recover',id:activation.id,previousSessionId:f.auth.sessionId}
  const results=await Promise.allSettled([f.save(activation),f.save(recovery,parent)])
  assert.equal(results[1].status,'fulfilled')
  if(results[0].status==='rejected') assert.equal(results[0].reason.status,401)
  assert.equal((await f.db.query("select count(*)::int n from native_kiosk_sessions where state='locked'")).rows[0].n,0)
  assert.equal((await f.db.query('select count(*)::int n from native_kiosk_recoveries')).rows[0].n,1)
  await assert.rejects(f.save(activation),error=>error.status===401)
  const device=randomUUID(), failed={action:'recover',id:randomUUID(),previousSessionId:'sess_failed_activation'}
  await f.db.query("create function fail_kiosk_recovery() returns trigger language plpgsql as $$ begin raise exception 'Receipt write interrupted'; end $$; create trigger fail_kiosk_recovery before insert on native_kiosk_recoveries for each row execute function fail_kiosk_recovery()")
  await assert.rejects(f.save(failed,{deviceId:device,sessionId:'sess_new_parent'}),/Receipt write interrupted/)
  assert.equal((await f.db.query('select count(*)::int n from native_kiosk_recoveries where kiosk_id=$1',[failed.id])).rows[0].n,0)
  assert.equal((await f.db.query('select count(*)::int n from native_notification_installations where device_id=$1',[device])).rows[0].n,0)
  assert.equal((await f.guard(f.request('/api/leader/flow'),undefined,{sessionId:failed.previousSessionId})).status,200)
})

test('K01 kiosk API validates account/session/installation proof and manager configuration before activation', { skip: !url }, async t => {
  const f = await fixture(t)
  const route = bundle(['app/api/mobile/kiosk/route.ts'], { ...f.mocks, '@/lib/usage-controls': { enforceRequestLimit: async () => {} } })
  const headers = { 'X-Task-Save-User': 'parent', 'X-Cyntch-Session': f.auth.sessionId, 'X-Cyntch-Device': f.deviceId, 'X-Cyntch-Installation': f.secret }
  const send = (body, overrides = {}) => route.POST(f.request('/api/mobile/kiosk', body, { ...headers, ...overrides }))
  for (const overrides of [{ 'X-Task-Save-User': 'child' }, { 'X-Cyntch-Session': 'sess_stale' }]) assert.equal((await send(f.activation(), overrides)).status, 403)
  for (const change of [{ visibleMemberIds: [] }, { editableMemberIds: ['hidden'] }, { exitSecret: 'short' }, { householdId: 'invalid' }]) {
    assert.equal((await send(f.activation(change))).status, 400)
  }
  assert.equal((await send(f.activation({ visibleMemberIds: ['outsider'], editableMemberIds: [] }))).status, 409)
  f.auth.userId = 'child'
  assert.equal((await send(f.activation(), { 'X-Task-Save-User': 'child' })).status, 403)
  f.auth.userId = 'parent'
  assert.equal((await f.db.query('select count(*)::int n from native_kiosk_sessions')).rows[0].n, 0)
  const operation = f.activation()
  const result = await send(operation)
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.equal((await route.GET(f.request('/api/mobile/kiosk', undefined, headers))).status, 200)
  assert.equal((await send({ action: 'unlock', id: operation.id, exitSecret: f.exitSecret }, { 'X-Cyntch-Installation': 'c'.repeat(64) })).status, 403)
  assert.equal((await f.db.query('select state from native_kiosk_sessions where id=$1', [operation.id])).rows[0].state, 'locked')
})

test('K02 activation waits for an admitted request; rollback and deleted households cannot leave a partial or bypassed lock', { skip: !url }, async t => {
  const f = await fixture(t), operation = f.activation()
  let release
  const running = f.guard(f.request('/api/leader/flow'),async()=>{await new Promise(resolve=>{release=resolve}); return Response.json({ok:true})})
  await until(()=>Boolean(release))
  const locking = f.save(operation)
  try {
    await until(async()=>Number((await f.admin.query("select count(*) as n from pg_stat_activity where application_name=$1 and wait_event='advisory'",[f.schema])).rows[0].n)>0)
    assert.equal((await f.db.query('select count(*)::int as n from native_kiosk_sessions')).rows[0].n,0)
  } finally { release() }
  await Promise.all([running,locking])
  await assert.rejects(f.guard(f.request('/api/leader/flow')),error=>error.status===423)
  await f.db.query('delete from households where id=$1',[f.householdId])
  await assert.rejects(f.guard(f.request('/api/mobile/bootstrap')),error=>error.status===423)
  assert.equal((await f.db.query('select state from native_kiosk_sessions where id=$1',[operation.id])).rows[0].state,'locked')
  await f.save({action:'unlock',id:operation.id,exitSecret:f.exitSecret})
  await f.db.query("create function reject_kiosk() returns trigger language plpgsql as $$ begin raise exception 'disk failure'; end $$; create trigger reject_kiosk before insert on native_kiosk_sessions for each row execute function reject_kiosk()")
  await assert.rejects(f.save(f.activation({householdId:f.other,visibleMemberIds:['parent'],editableMemberIds:[]})),/disk failure/)
  assert.equal((await f.db.query("select count(*)::int as n from native_kiosk_sessions where state='locked'")).rows[0].n,0)
})

test('K03 read-only kiosk and current assignments are enforced again at the household write boundary', { skip: !url }, async t => {
  const f=await fixture(t), first=f.activation({editableMemberIds:[]}); await f.save(first)
  const change={action:'setOccurrenceTaskCompleted',householdId:f.householdId,occurrenceId:f.occurrenceId,taskId:f.taskId,actorMemberId:'child',completed:true,editableMemberIds:[],clientOperation:{deviceId:f.deviceId}}
  await assert.rejects(f.guard(f.request('/api/mobile/completions',change)),error=>error.status===403)
  await f.save({action:'unlock',id:first.id,exitSecret:f.exitSecret}); await f.save(f.activation())
  await f.guard(f.request('/api/mobile/completions',change),async request=>{
    await f.db.query("delete from task_assignees where task_id=$1 and user_id='child'",[f.taskId])
    const client=await f.db.connect()
    try { await assert.rejects(f.lib.recheckNativeKioskFlow(client,'parent','sess_tablet',request),error=>error.status===403) } finally {client.release()}
    return Response.json({ok:false})
  })
})

test('N02 shared kiosks suppress queued/new push deliveries without changing another device preferences', { skip: !url }, async t => {
  const f=await fixture(t), operation=f.activation(), phone=randomUUID()
  // Register both installations before generating the event under test.
  await f.save(operation); await f.save({action:'unlock',id:operation.id,exitSecret:f.exitSecret})
  await f.db.query("insert into native_notification_installations(device_id,secret_hash) values($1,repeat('e',64))",[phone])
  const prefs=f.lib.defaultNotificationPreferences('parent','UTC'); prefs.categories.task_completed={enabled:true,memberIds:['child']}
  for(const [id,session] of [[f.deviceId,'sess_tablet'],[phone,'sess_phone']]) {
    await f.db.query("insert into native_notification_devices(user_id,device_id,platform,permission,expo_push_token,session_id,created_at) values('parent',$1,'android','granted',$2,$3,now()-interval '1 day')",[id,`ExpoPushToken[${id}]`,session])
    await f.db.query("insert into native_notification_preferences(user_id,device_id,household_id,preferences) values('parent',$1,$2,$3)",[id,f.householdId,JSON.stringify(prefs)])
  }
  await f.db.query('delete from native_notification_events')
  await f.db.query("update occurrence_tasks set status='completed' where occurrence_id=$1 and task_id=$2",[f.occurrenceId,f.taskId])
  await f.lib.expandNativeNotificationEvents(f.db)
  assert.equal((await f.db.query("select count(*)::int as n from native_notification_deliveries where state='queued'")).rows[0].n,2)
  const current=f.activation(); await f.save(current)
  const claims=await f.lib.claimNativeNotificationDeliveries(f.db)
  assert.equal(claims.length,1); assert.match(claims[0].message.to,new RegExp(phone))
  await f.save({action:'unlock',id:current.id,exitSecret:f.exitSecret})
  assert.deepEqual(await f.lib.claimNativeNotificationDeliveries(f.db),[],'unlock does not produce a backlog')
})

test('K03 every native-reachable parent API rejects a locked session before its handler runs', { skip: !url }, async t => {
  const f=await fixture(t); await f.save(f.activation())
  const paths=['leader/flow','mobile/runs','mobile/join','mobile/notifications','billing/checkout','billing/portal','billing/reconcile','billing/selection',
    'notifications/list','notifications/mark-read','notifications/mark-all-read','notifications/delete-all','notifications/preferences',
    'notifications/push/subscribe','notifications/push/unsubscribe','notifications/push/test','notifications/mobile/register','notifications/mobile/unregister']
  for(const relative of paths) {
    const filename=path.join(root,'app/api',relative,'route.ts'), loaded=new Module(filename,module)
    loaded.require=name=>name==='@/lib/native-kiosk-guard'?f.lib:f.mocks[name]??(name==='next/server'?{NextResponse:{json:Response.json}}:name.startsWith('@/')?{}:require(name))
    loaded._compile(transformSync(fs.readFileSync(filename,'utf8'),{loader:'ts',format:'cjs'}).code,filename)
    for(const method of ['GET','POST']) if(loaded.exports[method]) {
      const request=f.request('/api/'+relative,method==='POST'?{action:'createHousehold',householdId:f.householdId}:undefined)
      const result=await loaded.exports[method](request)
      assert.equal(result.status,423,relative+' '+method)
    }
  }
})
