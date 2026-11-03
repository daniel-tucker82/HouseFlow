/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL lifecycle fixtures; never application or production credentials. */
const assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const {Pool}=require('pg'),{buildSync}=require('esbuild'),root=path.resolve(__dirname,'../..')
exports.connectionString=process.env.CYNTCH_TEST_DATABASE_URL
exports.fixture=async function fixture(t){
 const connectionString=exports.connectionString,url=new URL(connectionString)
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.pathname==='/cyntch_mobile_test')
 const admin=new Pool({connectionString}),schema=`deletion_${randomUUID().replaceAll('-','')}`;await admin.query(`create schema ${schema}`)
 const db=new Pool({connectionString,options:`-c search_path=${schema}`,max:10})
 t.after(async()=>{await db.end();await admin.query(`drop schema ${schema} cascade`);await admin.end()})
 for(const name of ['app_role','routine_type','task_status','occurrence_status','notification_kind']){
  const labels=(await admin.query(`select e.enumlabel from pg_enum e join pg_type p on p.oid=e.enumtypid join pg_namespace n on n.oid=p.typnamespace where p.typname=$1 and n.nspname='public' order by e.enumsortorder`,[name])).rows
  if(labels.length)await db.query(`create type ${name} as enum (${labels.map(row=>"'"+row.enumlabel.replaceAll("'","''")+"'").join(',')})`)
 }
 for(const file of fs.readdirSync(path.join(root,'database')).filter(file=>file.endsWith('.sql')).sort())await db.query(fs.readFileSync(path.join(root,'database',file),'utf8'))
 await db.query(fs.readFileSync(path.join(root,'database/0034_account_deletion_requests.sql'),'utf8'))
 const owner='user_delete_'+randomUUID(),successor='user_successor_'+randomUUID(),other='user_other_'+randomUUID(),child='local_member_'+randomUUID(),sharedChild='local_member_'+randomUUID()
 for(const [id,name]of[[owner,'Deleting parent'],[successor,'Other parent'],[other,'Unrelated parent'],[child,'Local child'],[sharedChild,'Shared profile']])await db.query('insert into users(id,full_name,email) values($1,$2,$3)',[id,name,id.startsWith('user_')?'fixture@private.test':null])
 const transfer=randomUUID(),deleting=randomUUID(),shared=randomUUID(),device=randomUUID(),otherDevice=randomUUID()
 const scope={accountId:owner,sessionId:'sess_'+randomUUID(),deviceId:device},secret='a'.repeat(64)
 await db.query("insert into households(id,name,leader_id) values($1,'Keep this family',$4),($2,'Delete this family',$4),($3,'Other family',$5)",[transfer,deleting,shared,owner,other])
 for(const [hh,user,role]of[[transfer,owner,'manager'],[transfer,successor,'supervisor'],[deleting,owner,'manager'],[deleting,child,'member'],[deleting,sharedChild,'member'],[shared,sharedChild,'member'],[shared,owner,'member'],[shared,other,'manager']])await db.query('insert into household_members(household_id,user_id,role) values($1,$2,$3)',[hh,user,role])
 for(const [hh,user]of[[transfer,successor],[deleting,owner],[shared,other]])await db.query("insert into routines(household_id,name,created_by) values($1,'Fixture routine',$2)",[hh,user])
 await db.query('insert into household_invites(household_id,created_by,code,expires_at) values($1,$2,$3,now()+interval \'1 day\')',[shared,owner,randomUUID()])
 await db.query("insert into household_billing(household_id,stripe_customer_id,stripe_subscription_id,subscription_status) values($1,'cus_transfer','sub_transfer','active'),($2,'cus_delete','sub_delete','active')",[transfer,deleting])
 const native=randomUUID();await db.query("insert into native_billing_accounts(id,household_id,project_id,environment) values($1,$2,'proj_fixture','sandbox')",[native,deleting])
 await db.query("insert into native_subscriptions(project_id,subscription_id,account_id,store,product_id,status,auto_renewal_status,gives_access,access_through,verified_at) values('proj_fixture','sub_native',$1,'play_store','annual','active','will_renew',true,now()+interval '5 days',now())",[native])
 for(const [user,id]of[[owner,device],[other,otherDevice]]){
  await db.query('insert into native_notification_installations(device_id,secret_hash) values($1,$2)',[id,createHash('sha256').update(secret).digest('hex')])
  await db.query("insert into native_notification_devices(user_id,device_id,platform,permission,session_id) values($1,$2,'android','denied',$3)",[user,id,scope.sessionId])
  await db.query('insert into push_subscriptions(user_id,device_id,endpoint,p256dh,auth) values($1,$2,$3,\'key\',\'auth\')',[user,id,'https://push.test/'+id])
  await db.query("insert into mobile_push_tokens(user_id,token,platform) values($1,$2,'android')",[user,'token-'+id])
 }
 const identity={userId:owner,sessionId:scope.sessionId},mocks={'@/lib/db':{db,kioskGateDb:db},'@clerk/nextjs/server':{auth:async()=>identity,currentUser:async()=>({id:identity.userId,emailAddresses:[],firstName:'Restored',lastName:'Profile',hasImage:false})}}
 function load(files,extra={}){const deps={...mocks,...extra},loaded=new Module(__filename,module);loaded.require=name=>deps[name]??require(name);loaded._compile(buildSync({stdin:{contents:files.map(file=>`export * from ${JSON.stringify(path.join(root,file))}`).join(';'),resolveDir:root},bundle:true,platform:'node',format:'cjs',write:false,external:Object.keys(deps)}).outputFiles[0].text,__filename);return loaded.exports}
 const lib=load(['lib/account-deletion-requests.ts','lib/account-deletion-processing.ts','lib/account-deletion-data.ts','lib/account-deletion-review.ts','lib/account-access.ts','lib/native-kiosk-guard.ts','lib/native-kiosk-store.ts','lib/user-sync.ts','lib/usage-controls.ts','lib/planner-creation.ts','lib/completion-operations.ts','lib/native-notification-settings.ts','shared/mobile/kiosk.ts'])
 const read=()=>lib.readAccountDeletionReview(scope,secret)
 const intent=async()=>({operationId:randomUUID(),revision:(await read()).revision,ownership:[{householdId:transfer,action:'transfer',successorId:successor},{householdId:deleting,action:'delete'}],confirmAccountDeletion:true,acknowledgeSubscriptions:true})
 const accept=(action,options={})=>lib.acceptAccountDeletion(db,options.scope??scope,options.secret??secret,action,options.verified??true,options.verify??(async ids=>assert.deepEqual(ids,[successor])))
 return {db,lib,load,scope,secret,owner,successor,other,child,sharedChild,transfer,deleting,shared,native,otherDevice,read,intent,accept,identity}
}
