/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL notification-history isolation and pagination. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto')
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Pool}=require('pg'),{buildSync}=require('esbuild')
const root=path.resolve(__dirname,'..'),connectionString=process.env.CYNTCH_TEST_DATABASE_URL
function load(files,mocks={}){const m=new Module(__filename,module);m.require=name=>mocks[name]??require(name);m._compile(buildSync({stdin:{contents:files.map(file=>`export * from ${JSON.stringify(path.join(root,file))}`).join(';'),resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:Object.keys(mocks)}).outputFiles[0].text,__filename);return m.exports}
async function fixture(t){
 const url=new URL(connectionString);assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.pathname==='/cyntch_mobile_test')
 const admin=new Pool({connectionString}),schema=`history_${randomUUID().replaceAll('-','')}`
 await admin.query(`create schema ${schema}`)
 const db=new Pool({connectionString,options:`-c search_path=${schema}`,max:8})
 t.after(async()=>{await db.end();await admin.query(`drop schema ${schema} cascade`);await admin.end()})
 for(const name of ['app_role','routine_type','task_status','occurrence_status','notification_kind']){
  const labels=(await admin.query(`select e.enumlabel from pg_enum e join pg_type p on p.oid=e.enumtypid join pg_namespace n on n.oid=p.typnamespace where p.typname=$1 and n.nspname='public' order by e.enumsortorder`,[name])).rows
  if(labels.length)await db.query(`create type ${name} as enum (${labels.map(r=>"'"+r.enumlabel.replaceAll("'","''")+"'").join(',')})`)
 }
 for(const file of fs.readdirSync(path.join(root,'database')).filter(f=>f.endsWith('.sql')).sort())await db.query(fs.readFileSync(path.join(root,'database',file),'utf8'))
 await db.query(fs.readFileSync(path.join(root,'database/0033_notification_history.sql'),'utf8'))
 for(const user of ['parent','child','supervisor','outsider'])await db.query('insert into users(id) values($1)',[user])
 const scope={accountId:'parent',sessionId:'history_session',deviceId:randomUUID(),householdId:randomUUID()},secret='a'.repeat(64)
 await db.query("insert into households(id,name,leader_id) values($1,'History household','parent')",[scope.householdId])
 for(const [user,role]of[['parent','manager'],['child','member'],['supervisor','supervisor']])await db.query('insert into household_members(household_id,user_id,role) values($1,$2,$3)',[scope.householdId,user,role])
 await db.query('delete from native_notification_events where household_id=$1',[scope.householdId])
 await db.query('insert into native_notification_installations(device_id,secret_hash) values($1,$2)',[scope.deviceId,createHash('sha256').update(secret).digest('hex')])
 for(const user of ['parent','child','supervisor'])await db.query("insert into native_notification_devices(user_id,device_id,platform,permission) values($1,$2,'android','denied')",[user,scope.deviceId])
 const mocks={'@/lib/db':{db,kioskGateDb:db},'@clerk/nextjs/server':{auth:async()=>({userId:scope.accountId,sessionId:scope.sessionId})},'@/lib/usage-controls':{enforceRequestLimit:async()=>{}}}
 const lib=load(['lib/mobile-notification-history.ts','shared/mobile/notification-catalog.ts'],mocks),route=load(['app/api/mobile/notification-history/route.ts'],mocks)
 const read=(who=scope,source='app',cursor)=>lib.readNotificationHistory(who,secret,new URLSearchParams({source,...(cursor?{cursor}:{})}))
 const act=(action,who=scope,source='app')=>lib.updateNotificationHistory(who,secret,{householdId:who.householdId,source,...action})
 async function preferences(user='parent',device=scope.deviceId,enabled=Object.keys(lib.notificationCatalog)){
  const pref=lib.defaultNotificationPreferences(user,'Australia/Sydney');pref.enabled=false;pref.quietHours={start:'00:00',end:'00:00'}
  for(const [kind,rule]of Object.entries(pref.categories)){rule.enabled=enabled.includes(kind);rule.memberIds=lib.notificationCatalog[kind].scope==='member'?['child']:[]}
  await db.query(`insert into native_notification_preferences(user_id,device_id,household_id,preferences) values($1,$2,$3,$4)
    on conflict(user_id,device_id,household_id) do update set preferences=excluded.preferences`,[user,device,scope.householdId,JSON.stringify(pref)])
 }
 async function event(kind='task_completed',extra={}){
  const id=randomUUID();await db.query(`insert into native_notification_events(id,household_id,event_key,kind,subject,member_ids,occurred_at,expires_at,state)
    values($1::uuid,$2,$1::uuid::text,$3,$4,$5,coalesce($6::timestamptz,now()-interval '2 days'),now()-interval '1 day','expired')`,
    [id,scope.householdId,kind,JSON.stringify({name:'Pack bag',occurrenceId:randomUUID(),taskId:randomUUID(),...extra.subject}),extra.members??['child'],extra.time??null]);return id
 }
 async function legacy(kind='task_unlocked_self'){
  const eventId=randomUUID(),id=randomUUID();await db.query('insert into notification_events(id,household_id,kind,metadata) values($1,$2,$3,$4)',[eventId,scope.householdId,kind,JSON.stringify({url:'https://evil.test',occurrenceId:randomUUID()})])
  await db.query("insert into user_notifications(id,event_id,user_id,title,body) values($1,$2,'parent','Old notification','Previously delivered on the website')",[id,eventId]);return id
 }
 function request(action,headers={}){return new Request(`https://cyntch.test/api/mobile/notification-history?householdId=${scope.householdId}`,{method:action?'POST':'GET',headers:{'X-Task-Save-User':scope.accountId,'X-Cyntch-Session':scope.sessionId,'X-Cyntch-Device':scope.deviceId,'X-Cyntch-Installation':secret,...headers},...(action?{body:JSON.stringify({householdId:scope.householdId,source:'app',...action})}:{})})}
 await preferences()
 return {db,scope,secret,lib,route,read,act,event,legacy,preferences,request}
}
test('notification history retains quiet/expired events, controls access and preserves stable pages',{skip:!connectionString},async t=>{
 const f=await fixture(t)
 await t.test('all fifteen categories retain accurate reasons while OS permission and quiet hours silence pushes',async()=>{
  for(const kind of Object.keys(f.lib.notificationCatalog))await f.event(kind)
  const page=await f.read();assert.equal(page.items.length,15)
  assert.match(page.items.find(i=>i.kind==='routine_superseded').body,/newer copy/)
  assert.match(page.items.find(i=>i.kind==='routine_completed').body,/through its tasks/)
  assert.match(page.items.find(i=>i.kind==='member_added').body,/profile/)
  assert.equal((await f.db.query('select count(*)::int n from native_notification_deliveries')).rows[0].n,0)
 })
 await t.test('device category selections and current roles fence history',async()=>{
  await f.preferences('parent',f.scope.deviceId,['task_completed'])
  assert.deepEqual((await f.read()).items.map(i=>i.kind),['task_completed'])
  const child=await f.read({...f.scope,accountId:'child'});assert.equal(child.items.every(i=>['task_available','reward_available'].includes(i.kind)),true)
  const supervisor=await f.read({...f.scope,accountId:'supervisor'});assert.equal(supervisor.items.every(i=>!f.lib.notificationCatalog[i.kind].managementOnly),true)
  await assert.rejects(f.read({...f.scope,accountId:'outsider'}),{status:403})
  await assert.rejects(f.lib.readNotificationHistory(f.scope,'b'.repeat(64),new URLSearchParams()),{status:403});await f.preferences()
 })
 await t.test('equal-time pages neither skip nor repeat events; filters invalidate old cursors',async()=>{
  await f.db.query('delete from native_notification_events')
  const ids=[];for(let i=0;i<56;i++)ids.push(await f.event('task_completed',{time:'2026-10-01T01:02:03.123456Z'}))
  let cursor,seen=[];do{const page=await f.read(f.scope,'app',cursor);seen.push(...page.items.map(i=>i.id));cursor=page.nextCursor}while(cursor)
  assert.deepEqual(seen,ids.sort().reverse());assert.equal(new Set(seen).size,56)
  const first=await f.read();await f.preferences('parent',f.scope.deviceId,['task_available']);await assert.rejects(f.read(f.scope,'app',first.nextCursor),{status:409});await f.preferences()
 })
 await t.test('read and dismiss are idempotent; bulk actions leave newer events intact',async()=>{
  const first=await f.read(),id=first.items[0].id
  await f.act({action:'read',notificationId:id});await f.act({action:'read',notificationId:id});assert.equal((await f.read()).items.find(i=>i.id===id).read,true)
  await f.act({action:'dismiss',notificationId:id});await f.act({action:'dismiss',notificationId:id});assert.equal((await f.read()).items.some(i=>i.id===id),false)
  await f.act({action:'readAll',through:first.through});assert.equal((await f.read()).items.every(i=>i.read),true)
  const later=await f.event('task_completed',{time:new Date().toISOString()})
  await f.act({action:'dismissAll',through:first.through});await f.act({action:'dismissAll',through:first.through})
  assert.deepEqual((await f.read()).items.map(i=>i.id),[later])
  assert.equal((await f.db.query('select count(*)::int n from native_notification_events')).rows[0].n,57,'History dismissal must not delete transitions')
  await assert.rejects(f.act({action:'dismissAll',through:{time:'2099-01-01T00:00:00.000000Z',id}}),{status:400})
 })
 await t.test('website history retains account read state and never exposes external navigation URLs',async()=>{
  const id=await f.legacy();await f.legacy('member_joined_via_link')
  const page=await f.read(f.scope,'web');assert.equal(page.items.length,2);assert.equal(JSON.stringify(page).includes('evil.test'),false)
  await f.act({action:'read',notificationId:id},f.scope,'web');assert.equal((await f.read(f.scope,'web')).items.find(i=>i.id===id).read,true)
  await f.db.query("update household_members set role='member' where household_id=$1 and user_id='parent'",[f.scope.householdId])
  assert.deepEqual((await f.read(f.scope,'web')).items.map(i=>i.id),[id])
  await f.db.query("update household_members set role='manager' where household_id=$1 and user_id='parent'",[f.scope.householdId])
  await f.act({action:'dismissAll',through:page.through},f.scope,'web');assert.equal((await f.read(f.scope,'web')).items.length,0)
 })
 await t.test('app read and clear state is independent on another installation',async()=>{
  const device=randomUUID(),other={...f.scope,deviceId:device}
  await f.db.query('insert into native_notification_installations(device_id,secret_hash) values($1,$2)',[device,createHash('sha256').update(f.secret).digest('hex')])
  await f.db.query("insert into native_notification_devices(user_id,device_id,platform,permission) values('parent',$1,'android','denied')",[device])
  await f.preferences('parent',device)
  const own=await f.read(),second=await f.read(other);assert.equal(own.items.length,1);assert.equal(second.items.length,25)
  await f.act({action:'read',notificationId:own.items[0].id},other)
  assert.equal((await f.read()).items[0].read,false)
 })
 await t.test('invalid and normalized calendar dates are rejected before database access',async()=>{
  for(const time of ['2026-02-30T00:00:00.000000Z','0000-01-01T00:00:00.000000Z','2026-11-04T25:00:00.000000Z']){
   assert.throws(()=>f.lib.parseNotificationHistoryAction({householdId:f.scope.householdId,source:'app',action:'dismissAll',through:{time,id:randomUUID()}}),{status:400})
  }
 })
 await t.test('API rejects changed identities and kiosk routes, and marks responses no-store',async()=>{
  assert.equal((await f.route.GET(f.request(null,{'X-Cyntch-Session':'old'}))).status,403)
  const ok=await f.route.GET(f.request());assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'no-store')
  assert.equal((await f.route.POST(f.request({action:'dismiss',notificationId:'bad'}))).status,400)
  await f.db.query(`insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash)
    values($1,'parent',$2,$3,$4,array['child'],array['child'],$5,$5)`,[randomUUID(),f.scope.sessionId,f.scope.deviceId,f.scope.householdId,'a'.repeat(64)])
  assert.equal((await f.route.GET(f.request())).status,423)
  assert.equal((await f.route.POST(f.request({action:'read',notificationId:randomUUID()}))).status,423)
 })
})
