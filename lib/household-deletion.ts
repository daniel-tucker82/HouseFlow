import { randomUUID } from "node:crypto"
import type { Pool } from "pg"
import { accountHash, lockActiveAccount } from "@/lib/account-access"
import { EntitlementError } from "@/lib/entitlements"
import { SchedulerDeadline, schedulerTransaction } from "@/lib/scheduler-deadline"
import type { HouseholdDeletionReceipt } from "@/shared/mobile/household-deletion"

const receiptColumns = 'id,household_id as "householdId",state,created_at as "createdAt",completed_at as "completedAt"'

/** The household write lock excludes new Checkout/store reservations. Persist
 * cleanup and delete household data in one transaction; never discard billing
 * information in anticipation of a successful provider request. */
export async function acceptHouseholdDeletion(pool: Pool, accountId: string, householdId: string, confirmed: boolean,
  env: NodeJS.ProcessEnv = process.env): Promise<HouseholdDeletionReceipt> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(householdId)) throw new EntitlementError("Choose a valid household.", 400)
  if (!confirmed) throw new EntitlementError("Confirm household deletion and the subscription information before continuing.", 400)
  return schedulerTransaction(pool, new SchedulerDeadline(8_000), async client => {
    await lockActiveAccount(client, accountId)
    if (!(await client.query<{ acquired: boolean }>("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired", [householdId])).rows[0].acquired) {
      throw new EntitlementError("Another household change is in progress. Please retry.", 429)
    }
    const hash = accountHash(accountId)
    const previous = (await client.query<HouseholdDeletionReceipt & { account_hash: string }>(`select ${receiptColumns},account_hash from household_deletion_requests where household_id=$1`, [householdId])).rows[0]
    if (previous) {
      if (previous.account_hash !== hash) throw new EntitlementError("Household not found.", 404)
      return { id: previous.id, householdId: previous.householdId, state: previous.state, createdAt: previous.createdAt, completedAt: previous.completedAt }
    }
    const household = (await client.query<{ leader_id: string }>("select leader_id from households where id=$1 for update", [householdId])).rows[0]
    if (!household) throw new EntitlementError("Household not found.", 404)
    if (household.leader_id !== accountId) throw new EntitlementError("Only the household owner can delete it.", 403)
    if (env.HOUSEHOLD_DELETION_SUBMISSION_ENABLED !== "true") throw new EntitlementError("Household deletion is not available yet.", 503)
    if ((await client.query("select 1 from billing_purchase_attempts where household_id=$1 and state in ('reserved','submitted') and expires_at>now() limit 1", [householdId])).rowCount) {
      throw new EntitlementError("A subscription purchase is still in progress. Finish or cancel it before deleting this household.", 409)
    }
    const billing = (await client.query<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>(
      "select stripe_customer_id,stripe_subscription_id from household_billing where household_id=$1 for update", [householdId])).rows[0]
    const pending = Boolean(billing?.stripe_customer_id || billing?.stripe_subscription_id)
    if (pending && (env.HOUSEHOLD_DELETION_PROCESSING_ENABLED !== "true" || !/^[sr]k_(live|test)_\S+$/.test(env.STRIPE_SECRET_KEY ?? ""))) {
      throw new EntitlementError("Website subscription cleanup is not available. Your household has been kept. Please try again later.", 503)
    }
    const receipt = (await client.query<HouseholdDeletionReceipt>(`insert into household_deletion_requests
      (id,household_id,account_hash,state,stripe_customer_id,stripe_subscription_id,stripe_livemode,completed_at,next_attempt_at)
      values($1,$2,$3,$4,$5,$6,$7,case when $4='completed' then clock_timestamp() end,case when $4='pending' then now() end)
      returning ${receiptColumns}`, [randomUUID(), householdId, hash, pending ? "pending" : "completed",
      pending ? billing?.stripe_customer_id : null, pending ? billing?.stripe_subscription_id : null,
      pending ? /^[sr]k_live_/.test(env.STRIPE_SECRET_KEY!) : null])).rows[0]
    await client.query("delete from households where id=$1", [householdId])
    return receipt
  })
}

export async function listHouseholdDeletions(pool: Pool, accountId: string): Promise<HouseholdDeletionReceipt[]> {
  return (await pool.query<HouseholdDeletionReceipt>(`select ${receiptColumns} from household_deletion_requests
    where account_hash=$1 order by created_at desc,id desc limit 25`, [accountHash(accountId)])).rows
}
