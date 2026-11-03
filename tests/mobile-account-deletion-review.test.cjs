/* eslint-disable @typescript-eslint/no-require-imports -- Exercise real deletion-review SQL and authorization against isolated PostgreSQL. */
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto')
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{Pool}=require('pg'),{buildSync}=require('esbuild')
const root=path.resolve(__dirname,'..'),connectionString=process.env.CYNTCH_TEST_DATABASE_URL
function load(file,mocks){const loaded=new Module(__filename,module);loaded.require=name=>mocks[name]??require(name);loaded._compile(buildSync({entryPoints:[path.join(root,file)],bundle:true,platform:'node',format:'cjs',write:false,external:Object.keys(mocks)}).outputFiles[0].text,__filename);return loaded.exports}
async function fixture(t){
 const url=new URL(connectionString);assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.pathname==='/cyntch_mobile_test')
 const admin=new Pool({connectionString}),schema=`deletion_review_${randomUUID().replaceAll('-','')}`
 await admin.query(`create schema ${schema}`)
 const db=new Pool({connectionString,options:`-c search_path=${schema}`,max:8})
 t.after(async()=>{await db.end();await admin.query(`drop schema ${schema} cascade`);await admin.end()})
 for(const name of ['app_role','routine_type','task_status','occurrence_status','notification_kind']){
  const labels=(await admin.query(`select e.enumlabel from pg_enum e join pg_type p on p.oid=e.enumtypid join pg_namespace n on n.oid=p.typnamespace where p.typname=$1 and n.nspname='public' order by e.enumsortorder`,[name])).rows
  if(labels.length)await db.query(`create type ${name} as enum (${labels.map(row=>"'"+row.enumlabel.replaceAll("'","''")+"'").join(',')})`)
 }
 for(const file of fs.readdirSync(path.join(root,'database')).filter(file=>file.endsWith('.sql')).sort())await db.query(fs.readFileSync(path.join(root,'database',file),'utf8'))
 for(const [id,name]of[['user_parent','Parent'],['user_supervisor','Other parent'],['user_teen','Teen'],['local_member_child','Child'],['user_other','Other household owner'],['user_empty','No households']]){
  await db.query('insert into users(id,full_name,email) values($1,$2,$3)',[id,name,id.startsWith('local_')?null:id+'@private.test'])
 }
 const own=randomUUID(),shared=randomUUID(),previous=randomUUID(),scope={accountId:'user_parent',sessionId:'sess_review',deviceId:randomUUID()},secret='a'.repeat(64)
 await db.query("insert into households(id,name,leader_id) values($1,'Owned family','user_parent'),($2,'Shared family','user_other'),($3,'Secret former household','user_other')",[own,shared,previous])
 for(const [hh,user,role]of[[own,'user_parent','manager'],[own,'user_supervisor','supervisor'],[own,'user_teen','member'],[own,'local_member_child','supervisor'],[shared,'user_parent','member'],[shared,'user_other','manager'],[previous,'user_other','manager']])await db.query('insert into household_members(household_id,user_id,role) values($1,$2,$3)',[hh,user,role])
 const routine=randomUUID(),run=randomUUID(),task=randomUUID()
 await db.query("insert into routines(id,household_id,name,created_by) values($1,$2,'Owned routine','user_parent')",[routine,own])
 await db.query("insert into routine_occurrences(id,household_id,kind,title,scheduled_for,created_by) values($1,$2,'manual','Owned run',now(),'user_supervisor')",[run,own])
 await db.query("insert into tasks(id,household_id,title,created_by) values($1,$2,'My task','user_parent'),($3,$2,'Other task','user_supervisor'),($4,$5,'Shared task','user_parent'),($6,$7,'Former task','user_parent')",[task,own,randomUUID(),randomUUID(),shared,randomUUID(),previous])
 await db.query('insert into native_notification_installations(device_id,secret_hash) values($1,$2)',[scope.deviceId,createHash('sha256').update(secret).digest('hex')])
 await db.query("insert into household_billing(household_id,stripe_subscription_id,subscription_status,paid_through) values($1,'sub_private','active',now()+interval '10 days'),($2,'sub_others_private','active',now()+interval '10 days')",[own,shared])
 for(const [environment,store]of[['production','app_store'],['sandbox','play_store']]){
  const account=randomUUID();await db.query("insert into native_billing_accounts(id,household_id,project_id,environment) values($1,$2,'proj_private',$3)",[account,own,environment])
  await db.query("insert into native_subscriptions(project_id,subscription_id,account_id,store,product_id,status,auto_renewal_status,gives_access,access_through,verified_at) values('proj_private',$1,$2,$3,'product_private','active','will_renew',true,now()+interval '5 days',now())",['subscription_'+environment,account,store])
 }
 await db.query("insert into owner_entitlements(user_id,verified_email,verification_source) values('user_parent','owner@private.test','clerk_verified_email')")
 const auth={userId:scope.accountId,sessionId:scope.sessionId},mocks={'@/lib/db':{db,kioskGateDb:db},'@clerk/nextjs/server':{auth:async()=>auth},'@/lib/usage-controls':{enforceRequestLimit:async()=>{}}}
 const lib=load('lib/account-deletion-review.ts',mocks),route=load('app/api/mobile/account-deletion/route.ts',mocks)
 const read=()=>lib.readAccountDeletionReview(scope,secret)
 const intent=review=>lib.parseAccountDeletionIntent({operationId:randomUUID(),revision:review.revision,ownership:[{householdId:own,action:'transfer',successorId:'user_supervisor'}],confirmAccountDeletion:true,acknowledgeSubscriptions:true})
 const request=(headers={},query='')=>new Request('https://cyntch.test/api/mobile/account-deletion'+query,{headers:{'X-Task-Save-User':scope.accountId,'X-Cyntch-Session':scope.sessionId,'X-Cyntch-Device':scope.deviceId,'X-Cyntch-Installation':secret,...headers}})
 return {db,scope,secret,own,shared,previous,routine,run,task,lib,route,read,intent,request,auth}
}
test('account deletion review enumerates impact without exposing unrelated family or provider data',{skip:!connectionString},async t=>{
 const f=await fixture(t),before=await f.db.query('select (select count(*) from users) users,(select count(*) from households) households,(select count(*) from tasks) tasks')
 const review=await f.read(),own=review.households.find(h=>h.id===f.own),shared=review.households.find(h=>h.id===f.shared)
 assert.equal(review.households.length,2);assert.equal(shared.ownership,null)
 assert.equal(own.ownership.otherAccounts,2);assert.equal(own.ownership.profilesWithoutSignIn,1)
 assert.deepEqual(own.ownership.possibleSuccessors,[{id:'user_supervisor',name:'Other parent',role:'supervisor'}])
 assert.deepEqual(own.ownership.content,{routines:1,runs:1,tasks:2})
 assert.deepEqual(review.authoredContent,{routines:1,runs:0,tasks:3});assert.equal(review.permanentOwnerAccess,true)
 assert.deepEqual(own.ownership.billing.map(source=>source.provider).sort(),['app_store','play_store','stripe'])
 assert.equal(own.ownership.billing.find(source=>source.provider==='play_store').environment,'sandbox')
 const serialized=JSON.stringify(review)
 for(const hidden of ['private.test','sub_private','sub_others_private','proj_private','product_private','subscription_production','Secret former household',f.previous])assert.equal(serialized.includes(hidden),false,hidden)
 assert.deepEqual((await f.db.query('select (select count(*) from users) users,(select count(*) from households) households,(select count(*) from tasks) tasks')).rows,before.rows)
 assert.equal((await f.read()).revision,review.revision,'Reading again must not itself invalidate review')
})
test('deletion confirmation rejects changed membership, ownership, content and subscription reviews',{skip:!connectionString},async t=>{
 const f=await fixture(t)
 async function changes(sql,values){const before=await f.read(),intent=f.intent(before);await f.db.query(sql,values);const after=await f.read();assert.notEqual(after.revision,before.revision);assert.throws(()=>f.lib.validateAccountDeletionIntent(after,intent),{status:409,code:'account_deletion_review_changed'})}
 await changes("update household_members set role='member' where household_id=$1 and user_id='user_supervisor'",[f.own])
 await changes("update household_members set role='supervisor' where household_id=$1 and user_id='user_supervisor'",[f.own])
 await changes("update household_billing set cancel_at_period_end=true where household_id=$1",[f.own])
 await changes("update native_subscriptions set auto_renewal_status='will_not_renew' where subscription_id='subscription_production'")
 await changes("update native_subscriptions set pending_payment=true where subscription_id='subscription_production'")
 assert.equal((await f.read()).households.find(h=>h.owned).ownership.billing.find(source=>source.provider==='app_store').pendingPayment,true)
 // The number of tasks stays the same: an identity change still invalidates it.
 await changes('update tasks set id=$1 where id=$2',[randomUUID(),f.task])
 await changes("insert into billing_purchase_attempts(id,household_id,user_id,session_id,device_id,provider,environment,billing_interval,expires_at,integration_suffix) values($1,$2,'user_parent','sess_review',$3,'app_store','production','monthly',now()+interval '10 minutes','abcdefgh')",[randomUUID(),f.own,f.scope.deviceId])
 assert.equal((await f.read()).households.find(h=>h.owned).ownership.purchasePending,true)
 await changes("update households set leader_id='user_supervisor' where id=$1",[f.own])
})
test('deletion intent requires explicit choices and cannot nominate a child or unrelated account',{skip:!connectionString},async t=>{
 const f=await fixture(t),review=await f.read(),intent=f.intent(review)
 f.lib.validateAccountDeletionIntent(review,intent)
 f.lib.validateAccountDeletionIntent(review,{...intent,ownership:[{householdId:f.own,action:'delete'}]})
 for(const patch of [{confirmAccountDeletion:false},{acknowledgeSubscriptions:false},{operationId:'invalid'},{ownership:[...intent.ownership,...intent.ownership]},{ownership:[{householdId:f.own,action:'transfer',successorId:'local_member_child'}]}])assert.throws(()=>f.lib.parseAccountDeletionIntent({...intent,...patch}),{status:400})
 for(const ownership of [[],[{householdId:f.shared,action:'delete'}],[{householdId:f.own,action:'transfer',successorId:'user_teen'}],[{householdId:f.own,action:'transfer',successorId:'user_other'}]])assert.throws(()=>f.lib.validateAccountDeletionIntent(review,{...intent,ownership}),error=>[400,409].includes(error.status))
 const twoOwned={...review,households:[...review.households,{...review.households.find(h=>h.owned),id:randomUUID()}]}
 assert.throws(()=>f.lib.validateAccountDeletionIntent(twoOwned,{...intent,ownership:[...intent.ownership,...intent.ownership]}),{status:400})
 assert.notEqual((await f.lib.readAccountDeletionReview({...f.scope,sessionId:'sess_other'},f.secret)).revision,review.revision)
})
test('deletion review API is bound to the current session, installation and kiosk restrictions',{skip:!connectionString},async t=>{
 const f=await fixture(t)
 const ok=await f.route.GET(f.request({},'?accountId=user_other&householdId='+f.previous))
 assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'private, no-store');assert.equal(ok.headers.get('referrer-policy'),'no-referrer');assert.equal((await ok.json()).accountId,f.scope.accountId)
 assert.equal((await f.route.GET(f.request({'X-Task-Save-User':'user_other'}))).status,403)
 assert.equal((await f.route.GET(f.request({'X-Cyntch-Session':'sess_other'}))).status,403)
 assert.equal((await f.route.GET(f.request({'X-Cyntch-Device':'invalid'}))).status,400)
 assert.equal((await f.route.GET(f.request({'X-Cyntch-Installation':'b'.repeat(64)}))).status,403)
 assert.equal((await f.route.GET(f.request({'X-Cyntch-Installation':''}))).status,403)
 f.auth.userId=null;assert.equal((await f.route.GET(f.request())).status,401);f.auth.userId=f.scope.accountId
 await f.db.query('insert into native_notification_revocations(device_id,account_id,session_id) values($1,$2,$3)',[f.scope.deviceId,f.scope.accountId,f.scope.sessionId])
 assert.equal((await f.route.GET(f.request())).status,403)
 await f.db.query('delete from native_notification_revocations')
 await f.db.query("insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array['local_member_child'],array['local_member_child'],$6,$6)",[randomUUID(),f.scope.accountId,f.scope.sessionId,f.scope.deviceId,f.own,'a'.repeat(64)])
 assert.equal((await f.route.GET(f.request())).status,423)
 assert.equal((await f.route.GET(f.request({'X-Cyntch-Device':randomUUID()}))).status,423,'Omitting the correct installation cannot bypass session kiosk protection')
})
test('an account without households can still review deletion',{skip:!connectionString},async t=>{
 const f=await fixture(t),review=await f.lib.readAccountDeletionReview({...f.scope,accountId:'user_empty'},f.secret)
 assert.deepEqual(review.households,[]);assert.deepEqual(review.authoredContent,{routines:0,runs:0,tasks:0})
 assert.equal(review.permanentOwnerAccess,false)
 f.lib.validateAccountDeletionIntent(review,f.lib.parseAccountDeletionIntent({...f.intent(review),ownership:[]}))
 await assert.rejects(f.lib.readAccountDeletionReview({...f.scope,accountId:'user_missing'},f.secret),{status:404})
})
test('first-install review works before any push registration and does not create one',{skip:!connectionString},async t=>{
 const f=await fixture(t),deviceId=randomUUID()
 const response=await f.route.GET(f.request({'X-Cyntch-Device':deviceId}))
 assert.equal(response.status,200);assert.equal((await response.json()).deviceId,deviceId)
 assert.equal((await f.db.query('select 1 from native_notification_installations where device_id=$1',[deviceId])).rowCount,0)
 assert.equal((await f.db.query('select 1 from native_notification_devices')).rowCount,0)
})
test('native account review transport rejects replies from another identity or an incomplete review',async()=>{
 const {MobileApi}=load('mobile/src/services/api.ts',{}),scope={accountId:'user_parent',sessionId:'sess_review',deviceId:randomUUID()}
 const api=new MobileApi('https://cyntch.test',scope.accountId,scope.deviceId,async()=> 'test-token',async()=> 'a'.repeat(64),scope.sessionId)
 const good={...scope,revision:'a'.repeat(64),reviewedAt:new Date().toISOString(),households:[],authoredContent:{routines:0,runs:0,tasks:0},permanentOwnerAccess:false}
 const original=global.fetch
 try {
  let request
  global.fetch=async(url,options)=>{request={url,options};return Response.json(good)}
  assert.deepEqual(await api.accountDeletionReview(),good)
  assert.equal(request.options.method,'GET');assert.equal(request.url,'https://cyntch.test/api/mobile/account-deletion')
  assert.equal(request.options.headers['X-Cyntch-Installation'],'a'.repeat(64));assert.equal(request.options.headers['X-Cyntch-Session'],scope.sessionId)
  for(const key of ['accountId','sessionId','deviceId']){global.fetch=async()=>Response.json({...good,[key]:'other'});await assert.rejects(api.accountDeletionReview(),/different account/)}
  for(const patch of [{revision:''},{reviewedAt:'invalid'},{households:null}]){global.fetch=async()=>Response.json({...good,...patch});await assert.rejects(api.accountDeletionReview(),/incomplete account review/)}
 } finally {global.fetch=original}
})
