import type { Pool } from "pg"
import { accountAccessKey, accountHash } from "@/lib/account-access"
import { AccountDeletionDeferred, AccountDeletionProcessingError, type AccountDeletionJob } from "@/lib/account-deletion-processing"
import type { AccountDeletionWork } from "@/lib/account-deletion-requests"
import { removeAccountContent } from "@/lib/account-deletion-content"

/** Real PostgreSQL cleanup. This is called only for a durably accepted request,
 * by its current worker. It never accepts cleanup scope supplied by a client. */
export async function deleteAccountData(pool: Pool, job: AccountDeletionJob, budgetMs=20_000, now=()=>performance.now()) {
  const failed=()=>new AccountDeletionProcessingError("data_cleanup_failed")
  if(!Number.isFinite(budgetMs) || budgetMs<1 || budgetMs>40_000) throw failed()
  const deadline=now()+budgetMs,connection=await pool.connect()
  // Every SQL statement (including content preservation) shares one deadline.
  // PostgreSQL cancels a slow statement; rollback stays outside this wrapper.
  // Transaction-local settings cannot leak into the pooled connection.
  const client=new Proxy(connection,{
    get(target,property) {
      if(property==='query') return async (text:string,values?:unknown[])=>{
        const remaining=Math.floor(deadline-now())
        if(remaining<1) throw new AccountDeletionDeferred(1)
        await target.query("select set_config('statement_timeout',$1,true)",[`${remaining}ms`])
        if(now()>=deadline) throw new AccountDeletionDeferred(1)
        return target.query(text,values)
      }
      const value=Reflect.get(target,property)
      return typeof value==='function' ? value.bind(target) : value
    },
  })
  try {
    await connection.query("begin")
    await client.query("set local lock_timeout='2s'")
    const request=(await client.query<{account_hash:string;account_id:string|null;state:string;lease_id:string;valid:boolean;work:AccountDeletionWork}>(`select *,lease_until>clock_timestamp() as valid
      from account_deletion_requests where id=$1 for update`,[job.id])).rows[0]
    if(!request || request.account_hash!==accountHash(job.accountId)) throw failed()
    if(request.state==='completed' || request.work.phases.data){await client.query("commit");return}
    if(request.account_id!==job.accountId || request.lease_id!==job.leaseId || !request.valid) throw failed()
    if(!Array.isArray(request.work.deviceIds) || !Array.isArray(request.work.householdIds)) throw failed()
    const candidates=[job.accountId,...request.work.orphanProfileIds.filter(id=>/^local_member_[a-f0-9-]+$/i.test(id))].sort()
    for(const id of candidates) if(!(await client.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[accountAccessKey(id)])).rows[0].acquired) throw failed()
    await client.query("select id from users where id=any($1::text[]) order by id for update",[candidates])
    const accounts=(await client.query<{id:string}>(`select u.id from users u where u.id=any($1::text[]) and
      (u.id=$2 or (not exists(select 1 from household_members hm where hm.user_id=u.id)
      and not exists(select 1 from households h where h.leader_id=u.id))) order by u.id`,[candidates,job.accountId])).rows.map(row=>row.id)
    // Include the principal on retry even when its user row was already removed.
    if(!accounts.includes(job.accountId)) accounts.push(job.accountId)
    if((await client.query("select 1 from households where leader_id=any($1::text[])",[accounts])).rowCount) throw failed()
    const devices=request.work.deviceIds ?? []
    for(const id of [...devices].sort()) if(!(await client.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[`native-device:${id}`])).rows[0].acquired) throw failed()
    const affected=(await client.query<{id:string}>(`select id from households where id=any($2::uuid[]) or id in (
      select household_id from routines where created_by=any($1::text[])
      union select household_id from routine_occurrences where created_by=any($1::text[])
      union select t.household_id from tasks t where t.created_by=any($1::text[]) or t.assignee_id=any($1::text[])
        or exists(select 1 from task_assignees a where a.task_id=t.id and a.user_id=any($1::text[]))
    ) order by id`,[accounts,request.work.householdIds ?? []])).rows.map(row=>row.id)
    for(const id of affected) if(!(await client.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[id])).rows[0].acquired) throw failed()
    await client.query("select id from households where id=any($1::uuid[]) order by id for update",[affected])
    // Preserve a list before FK cascades erase attribution, including run copies.
    const contentIds=await removeAccountContent(client,accounts),identifiers=[...accounts,...contentIds]
    await client.query(`delete from notification_events where actor_user_id=any($1::text[]) or subject_member_user_id=any($1::text[])
      or cyntch_json_has_identifiers(metadata,$2::text[])`,[accounts,identifiers])
    await client.query(`delete from native_notification_events where member_ids && $1::text[] or cyntch_json_has_identifiers(subject,$2::text[])`,[accounts,identifiers])
    // Keep immutable request hashes/IDs, but never replay an erased snapshot.
    await client.query("update planner_creations set result='{\"dataRemoved\":true}'::jsonb where entity_id::text=any($1::text[])",[contentIds])
    for(const table of ["planner_creations","completion_operations"]) await client.query(`update ${table} set result='{"dataRemoved":true}'::jsonb
      where cyntch_json_has_identifiers(result,$1::text[])`,[identifiers])
    await client.query(`update native_notification_preferences set preferences=cyntch_json_remove_identifiers(preferences,$1::text[]),revision=revision+1,updated_at=now()
      where cyntch_json_has_identifiers(preferences,$1::text[])`,[accounts])
    await client.query(`update native_notification_operations set result=cyntch_json_remove_identifiers(result,$1::text[])
      where cyntch_json_has_identifiers(result,$1::text[])`,[accounts])
    await client.query(`update notification_preferences set task_unlocked_other_member_ids=cyntch_json_remove_identifiers(task_unlocked_other_member_ids,$1::text[]),
      reward_unlocked_other_member_ids=cyntch_json_remove_identifiers(reward_unlocked_other_member_ids,$1::text[])
      where cyntch_json_has_identifiers(task_unlocked_other_member_ids,$1::text[]) or cyntch_json_has_identifiers(reward_unlocked_other_member_ids,$1::text[])`,[accounts])
    for(const table of ["household_kiosk_settings","member_dashboard_lane_preferences","native_kiosk_sessions"]) await client.query(`update ${table} set
      visible_member_ids=array(select x from unnest(visible_member_ids) x where not x=any($1::text[])),
      editable_member_ids=array(select x from unnest(editable_member_ids) x where not x=any($1::text[]))
      where visible_member_ids && $1::text[] or editable_member_ids && $1::text[]`,[accounts])
    // Preserve last-change ordering for another member's task without retaining
    // the departing account/device identifier in the winning version.
    await client.query(`update completion_versions set device_id='retired:'||encode(sha256(convert_to(device_id,'UTF8')),'hex')
      where split_part(device_id,':',1)=any($1::text[]) or (device_id like 'web:%' and substring(device_id from 5)=any($1::text[]))`,[accounts])
    await client.query(`delete from completion_stream_versions where split_part(device_id,':',1)=any($1::text[])
      or (device_id like 'web:%' and substring(device_id from 5)=any($1::text[]))`,[accounts])
    // Keep pending purchase reservations until reconciliation/expiry so the
    // successor cannot accidentally start a second subscription during cleanup.
    await client.query(`update billing_purchase_attempts set user_id='deleted',session_id='deleted',
      device_id=case when device_id is null then null else '00000000-0000-0000-0000-000000000000'::uuid end
      where user_id=any($1::text[])`,[accounts])
    await client.query("delete from native_notification_revocations where account_id=any($1::text[])",[accounts])
    await client.query("delete from application_rate_limits where bucket_key=any($1::text[])",[accounts.flatMap(id=>['read','write','billing'].map(operation=>`${operation}:${id}`))])
    await client.query("delete from owner_entitlements where user_id=any($1::text[])",[accounts])
    await client.query("delete from household_invites where created_by=any($1::text[])",[accounts])
    await client.query("delete from users where id=any($1::text[])",[accounts])
    await client.query(`delete from native_notification_installations i where i.device_id=any($1::uuid[])
      and not exists(select 1 from native_notification_devices d where d.device_id=i.device_id)
      and not exists(select 1 from native_kiosk_sessions k where k.device_id=i.device_id)
      and not exists(select 1 from native_kiosk_recoveries k where k.device_id=i.device_id)
      and not exists(select 1 from native_kiosk_cancellations k where k.device_id=i.device_id)
      and not exists(select 1 from native_notification_revocations r where r.device_id=i.device_id)
      and not exists(select 1 from native_notification_operations o where o.device_id=i.device_id)
      and not exists(select 1 from native_notification_history_entries h where h.device_id=i.device_id)
      and not exists(select 1 from native_notification_history_markers h where h.device_id=i.device_id)`,[devices])
    // Account cleanup must not emit task-completion/member-left notifications
    // whose before-images contain just-erased content or display names.
    await client.query("delete from native_notification_changes where transaction_id=pg_current_xact_id()")
    await client.query("commit")
  } catch(error) {await connection.query("rollback");throw error} finally {connection.release()}
}
