import { randomBytes } from "node:crypto"
import type { PoolClient } from "pg"
import { EntitlementError } from "@/lib/entitlements"

export type BillingProvider = "stripe" | "app_store" | "play_store"
export type BillingAttemptIdentity = {
  id: string; householdId: string; userId: string; sessionId: string; deviceId: string | null
  provider: BillingProvider; interval: "monthly" | "yearly"
  environment: "production" | "sandbox"
}
export type BillingPurchaseAttempt = {
  id: string; household_id: string; user_id: string; session_id: string; device_id: string | null
  provider: BillingProvider; billing_interval: "monthly" | "yearly"
  environment: "production" | "sandbox"
  state: "reserved" | "submitted" | "released" | "expired"; expires_at: Date; integration_suffix: string
}
export class BillingPurchaseError extends EntitlementError {
  constructor(public code: "purchase_in_progress" | "attempt_expired" | "attempt_mismatch" | "existing_subscription", message: string) {
    super(message, 409)
  }
}
type Client = Pick<PoolClient, "query">

/** Caller holds the household advisory write lock. Expiration does not erase
 * the operation ID: an old request cannot resurrect an expired reservation. */
export async function activeBillingPurchase(client: Client, householdId: string, environment: "production" | "sandbox"): Promise<BillingPurchaseAttempt | null> {
  await client.query(`update billing_purchase_attempts set state='expired',updated_at=now()
    where household_id=$1::uuid and environment=$2 and state in ('reserved','submitted') and expires_at<=now()`, [householdId,environment])
  return (await client.query<BillingPurchaseAttempt>(`select * from billing_purchase_attempts
    where household_id=$1::uuid and environment=$2 and state in ('reserved','submitted')`, [householdId,environment])).rows[0] ?? null
}

function matches(row: BillingPurchaseAttempt, identity: BillingAttemptIdentity) {
  return row.id === identity.id && row.household_id === identity.householdId && row.user_id === identity.userId &&
    row.session_id === identity.sessionId && row.device_id === identity.deviceId &&
    row.provider === identity.provider && row.billing_interval === identity.interval && row.environment === identity.environment
}

export async function requireBillingPurchase(client: Client, identity: BillingAttemptIdentity) {
  await activeBillingPurchase(client, identity.householdId, identity.environment)
  const row = (await client.query<BillingPurchaseAttempt>("select * from billing_purchase_attempts where id=$1::uuid", [identity.id])).rows[0]
  if (!row || !matches(row, identity)) throw new BillingPurchaseError("attempt_mismatch", "This purchase belongs to a different session. Refresh billing before continuing.")
  if (!["reserved", "submitted"].includes(row.state)) throw new BillingPurchaseError("attempt_expired", "This purchase attempt has ended. Refresh billing before trying again.")
  return row
}

export async function reserveBillingPurchase(client: Client, identity: BillingAttemptIdentity) {
  const current = await activeBillingPurchase(client, identity.householdId, identity.environment)
  const previous = (await client.query<BillingPurchaseAttempt>("select * from billing_purchase_attempts where id=$1::uuid", [identity.id])).rows[0]
  if (previous) return requireBillingPurchase(client, identity)
  if (current) throw new BillingPurchaseError("purchase_in_progress", "A subscription purchase is already in progress for this household. Finish it before starting another.")
  const result = await client.query<BillingPurchaseAttempt>(`insert into billing_purchase_attempts
    (id,household_id,user_id,session_id,device_id,provider,billing_interval,expires_at,integration_suffix,environment)
    values($1::uuid,$2::uuid,$3,$4,$5::uuid,$6,$7,date_trunc('second',now())+$8*interval '1 second',$9,$10) returning *`,
  [identity.id,identity.householdId,identity.userId,identity.sessionId,identity.deviceId,identity.provider,identity.interval,
    identity.provider === "stripe" ? 3600 : 600,Array.from(randomBytes(8), n => String.fromCharCode(97 + n % 26)).join(""),identity.environment])
  return result.rows[0]
}

/** Persist before the external sheet is opened. Replays don't extend the hold. */
export async function submitNativeBillingPurchase(client: Client, identity: BillingAttemptIdentity) {
  await requireBillingPurchase(client, identity)
  return (await client.query<BillingPurchaseAttempt>(`update billing_purchase_attempts
    set state='submitted',expires_at=case when state='reserved' then now()+interval '24 hours' else expires_at end,updated_at=now()
    where id=$1::uuid returning *`, [identity.id])).rows[0]
}

export async function releaseBillingPurchase(client: Client, identity: BillingAttemptIdentity) {
  const row = (await client.query<BillingPurchaseAttempt>("select * from billing_purchase_attempts where id=$1::uuid", [identity.id])).rows[0]
  if (!row || !matches(row, identity)) throw new BillingPurchaseError("attempt_mismatch", "This purchase belongs to a different session.")
  await client.query(`update billing_purchase_attempts set state='released',updated_at=now()
    where id=$1::uuid and state in ('reserved','submitted')`, [identity.id])
}

/** Access expiry alone is not proof that renewal/approval cannot still charge.
 * Unknown, paused and retrying subscriptions must be resolved at their store. */
export async function assertNoNativeSubscription(client: Client, householdId: string, environment: "production" | "sandbox") {
  const result = await client.query(`select 1 from native_subscriptions s join native_billing_accounts a on a.id=s.account_id
    where a.household_id=$1::uuid and a.environment=$2 and
      (s.pending_payment or (s.gives_access and s.access_through>now()) or s.status not in ('expired','not_returned')) limit 1`, [householdId,environment])
  if (result.rowCount) throw new BillingPurchaseError("existing_subscription", "An existing store subscription needs attention. Manage it before starting another subscription.")
}
