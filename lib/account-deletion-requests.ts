import { createHash } from "node:crypto"
import type { Pool } from "pg"
import { accountAccessKey, accountHash, accountAccessDatabaseError, assertAccountActive } from "@/lib/account-access"
import { AccountDeletionError, parseAccountDeletionIntent, reviewAccountDeletion, validateAccountDeletionIntent } from "@/lib/account-deletion-review"
import { kioskSessionKey, readKioskForSession } from "@/lib/native-kiosk-store"
import { verifyInstallation } from "@/lib/native-notification-settings"
import { notificationUuid, notificationSessionId } from "@/shared/mobile/notification-settings"
import type { AccountDeletionScope } from "@/shared/mobile/account-deletion"

export interface AccountDeletionReceipt {
  accountId: string; requestId: string; state: "pending" | "completed"; acceptedAt: string; completedAt: string | null
}
export interface AccountDeletionWork {
  /** Provider identifiers stay server-side and are removed after processing. */
  stripe: { householdId: string; customerId: string | null; subscriptionId: string | null; action: "delete" | "transfer"; completed?: boolean }[]
  stripeHouseholds: { householdId: string; action: "delete" | "transfer" }[]
  stripeDiscovery: {
    complete: boolean; finalized?: boolean; livemode: boolean | null
    clocksComplete: boolean; clockCursor: string | null
    scans: { testClock: string | null; cursor: string | null; complete: boolean }[]
  }
  retiredNativeAccounts: { id: string; projectId: string; environment: "production" | "sandbox" }[]
  orphanProfileIds: string[]
  householdIds: string[]
  deviceIds: string[]
  phases: { data: boolean; stripe: boolean; native: boolean; identity: boolean }
}
type RequestRow = { id: string; account_hash: string; request_hash: string; state: AccountDeletionReceipt["state"]; created_at: Date; completed_at: Date | null }
function receipt(scope: AccountDeletionScope, row: RequestRow): AccountDeletionReceipt {
  return {accountId:scope.accountId,requestId:row.id,state:row.state,acceptedAt:row.created_at.toISOString(),completedAt:row.completed_at?.toISOString() ?? null}
}
const busy = () => new AccountDeletionError("Another account or household change is in progress. Please try again.",429,"account_deletion_busy")

/** Internal acceptance boundary. The HTTP caller must pass Clerk's current
 * auth.has({reverification:'strict'}) result, never a client-supplied boolean.
 * Do not wrap this in the normal shared account-admission lock. This function
 * takes its own exclusive account lock and shared kiosk lock in that order. */
export async function acceptAccountDeletion(pool: Pool, scope: AccountDeletionScope, secret: string, raw: unknown,
  recentlyVerified: boolean, verifySuccessors: (accountIds: string[]) => Promise<void>): Promise<AccountDeletionReceipt> {
  if (!/^user_[A-Za-z0-9_-]{1,200}$/.test(scope.accountId) || !notificationSessionId.test(scope.sessionId) || !notificationUuid.test(scope.deviceId)) throw new AccountDeletionError("Sign in again before deleting your account.",401)
  if (!recentlyVerified) throw new AccountDeletionError("Verify your sign-in again before deleting your account.",403,"account_reverification_required")
  const intent=parseAccountDeletionIntent(raw), fingerprint=createHash("sha256").update(JSON.stringify(intent)).digest("hex")
  // A provider lookup has no authority by itself. Membership and role are
  // checked again under the household locks after this network work finishes.
  const successors=[...new Set(intent.ownership.flatMap(choice=>choice.action==="transfer"?[choice.successorId]:[]))].sort()
  const prior=(await pool.query("select 1 from account_deletion_requests where account_hash=$1 or id=$2",[accountHash(scope.accountId),intent.operationId])).rowCount
  if (!prior && successors.length) await verifySuccessors(successors)
  const client=await pool.connect()
  try {
    await client.query("begin")
    await client.query("set local lock_timeout='2s'")
    await client.query("set local statement_timeout='15s'")
    if (!(await client.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[accountAccessKey(scope.accountId)])).rows[0].acquired) throw busy()
    if (!(await client.query("select pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) as acquired",[kioskSessionKey(scope.sessionId)])).rows[0].acquired) throw busy()
    if (!(await client.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[`native-device:${scope.deviceId}`])).rows[0].acquired) throw busy()
    const existing=(await client.query<RequestRow>("select * from account_deletion_requests where account_hash=$1 or id=$2",[accountHash(scope.accountId),intent.operationId])).rows
    // A lost receipt may be retried after data cleanup removed this installation.
    // Replaying an accepted request must never recreate erased device records.
    await verifyInstallation(client,scope.deviceId,secret,existing.length===0)
    if ((await client.query("select 1 from native_notification_revocations where account_id=$1 and device_id=$2 and session_id=$3",[scope.accountId,scope.deviceId,scope.sessionId])).rowCount) throw new AccountDeletionError("This sign-in session has ended.",403,"account_session_ended")
    const kiosk=await readKioskForSession(client,scope.accountId,scope.sessionId)
    if ((kiosk && kiosk.state!=="unlocked") || (await client.query("select 1 from native_kiosk_sessions where device_id=$1 and state='locked'",[scope.deviceId])).rowCount) throw new AccountDeletionError("Unlock kiosk mode before deleting an account.",423)
    if (existing.length) {
      const saved=existing.find(row=>row.account_hash===accountHash(scope.accountId))
      if (!saved || saved.id!==intent.operationId || saved.request_hash!==fingerprint || existing.length!==1) throw new AccountDeletionError("A different deletion request already exists. Check its status.",409,"account_deletion_request_exists")
      await client.query("commit");return receipt(scope,saved)
    }
    await assertAccountActive(client,scope.accountId)
    const lockedUser=await client.query("select id from users where id=$1 for update",[scope.accountId])
    if (!lockedUser.rowCount) throw new AccountDeletionError("Your account is no longer available.",404,"account_unavailable")
    const households=(await client.query<{id:string}>(`select distinct h.id from households h left join household_members hm on hm.household_id=h.id
      where h.leader_id=$1 or hm.user_id=$1 or h.id in (
        select household_id from routines where created_by=$1 union select household_id from tasks where created_by=$1
        union select household_id from routine_occurrences where created_by=$1) order by h.id`,[scope.accountId])).rows
    for (const household of households) {
      if (!(await client.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[household.id])).rows[0].acquired) throw busy()
    }
    // Row locks also cover membership/child inserts which don't use the quota
    // advisory lock. Lock in deterministic order and fail quickly on contention.
    await client.query("select id from households where id=any($1::uuid[]) order by id for update",[households.map(h=>h.id)])
    await client.query("select user_id from household_members where household_id=any($1::uuid[]) order by household_id,user_id for update",[households.map(h=>h.id)])
    const review=await reviewAccountDeletion(client,scope)
    validateAccountDeletionIntent(review,intent)
    const owned=intent.ownership.map(choice=>choice.householdId),deleting=intent.ownership.filter(choice=>choice.action==="delete").map(choice=>choice.householdId)
    const stripeRows=(await client.query<{household_id:string;stripe_customer_id:string|null;stripe_subscription_id:string|null}>("select household_id,stripe_customer_id,stripe_subscription_id from household_billing where household_id=any($1::uuid[]) and (stripe_customer_id is not null or stripe_subscription_id is not null)",[owned])).rows
    const retiredNativeAccounts=(await client.query<{id:string;projectId:string;environment:"production"|"sandbox"}>(`select id,project_id as "projectId",environment from native_billing_accounts where household_id=any($1::uuid[]) order by id`,[deleting])).rows
    const orphanProfileIds=(await client.query<{id:string}>(`select u.id from users u where u.id like 'local\\_member\\_%' escape '\\'
      and exists(select 1 from household_members hm where hm.user_id=u.id and hm.household_id=any($1::uuid[]))
      and not exists(select 1 from household_members hm where hm.user_id=u.id and not hm.household_id=any($1::uuid[])) order by u.id`,[deleting])).rows.map(row=>row.id)
    const deviceIds=(await client.query<{id:string}>(`select $2::uuid as id union select device_id from native_notification_devices where user_id=$1
      union select device_id from native_kiosk_sessions where user_id=$1 union select device_id from native_kiosk_recoveries where user_id=$1
      union select device_id from native_kiosk_cancellations where user_id=$1 union select device_id from native_notification_revocations where account_id=$1
      union select device_id from native_notification_operations where user_id=$1 union select device_id from native_notification_history_entries where user_id=$1
      union select device_id from native_notification_history_markers where user_id=$1`,[scope.accountId,scope.deviceId])).rows.map(row=>row.id)
    const work:AccountDeletionWork={householdIds:households.map(row=>row.id),deviceIds,
      stripeHouseholds:intent.ownership.map(({householdId,action})=>({householdId,action})),
      stripeDiscovery:{complete:false,livemode:null,clocksComplete:false,clockCursor:null,scans:[{testClock:null,cursor:null,complete:false}]},
      stripe:stripeRows.map(row=>({householdId:row.household_id,customerId:row.stripe_customer_id,subscriptionId:row.stripe_subscription_id,
      action:intent.ownership.find(choice=>choice.householdId===row.household_id)!.action})),retiredNativeAccounts,orphanProfileIds,phases:{data:false,stripe:false,native:false,identity:false}}
    const saved=(await client.query<RequestRow>(`insert into account_deletion_requests(id,account_hash,account_id,request_hash,work)
      values($1,$2,$3,$4,$5) returning *`,[intent.operationId,accountHash(scope.accountId),scope.accountId,fingerprint,JSON.stringify(work)])).rows[0]
    for (const choice of intent.ownership) if (choice.action==="transfer") {
      await assertAccountActive(client,choice.successorId)
      // This commits with the ownership change, before the successor can open
      // the former parent's payment account. Financial linkage remains for
      // paid-period/refund reconciliation, not access to the customer portal.
      // Freeze even households without a recorded customer: historical failed
      // checkouts can have an orphan Stripe customer that must be discovered.
      await client.query(`insert into household_billing(household_id,stripe_customer_retired) values($1,true)
        on conflict(household_id) do update set stripe_customer_retired=true,stripe_customer_deleted_at=null,updated_at=now()`,[choice.householdId])
      await client.query("update household_members set role='manager' where household_id=$1 and user_id=$2",[choice.householdId,choice.successorId])
      await client.query("update households set leader_id=$2,updated_at=now() where id=$1",[choice.householdId,choice.successorId])
    }
    await client.query("delete from households where id=any($1::uuid[]) and leader_id=$2",[deleting,scope.accountId])
    await client.query("delete from household_invites where created_by=$1",[scope.accountId])
    await client.query("delete from household_members where user_id=$1",[scope.accountId])
    await client.query("delete from push_subscriptions where user_id=$1",[scope.accountId])
    await client.query("delete from mobile_push_tokens where user_id=$1",[scope.accountId])
    // Cascades queued deliveries too. The request tombstone blocks registration
    // from another still-cached session; an already submitted push can't be recalled.
    await client.query("delete from native_notification_devices where user_id=$1",[scope.accountId])
    await client.query("commit")
    return receipt(scope,saved)
  } catch (error) {
    await client.query("rollback")
    if (["55P03","57014","40P01"].includes((error as {code?:string})?.code ?? "")) throw busy()
    throw accountAccessDatabaseError(error) ?? error
  } finally {client.release()}
}
