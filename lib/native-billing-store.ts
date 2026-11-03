import type { Pool } from "pg"

export class NativeBillingError extends Error {
  constructor(public code: "invalid_snapshot" | "identity_mismatch" | "purchase_already_bound" | "account_retired" | "configuration_mismatch" | "household_busy") {
    super(code)
    this.name = "NativeBillingError"
  }
}

export type NativeBillingAccount = {
  id: string
  household_id: string | null
  project_id: string
  environment: "production" | "sandbox"
}

/** Only a server-to-server provider adapter may construct these snapshots.
 * There is deliberately no HTTP endpoint accepting entitlement state. */
export type VerifiedNativeSubscription = {
  id: string
  originalCustomerId: string
  environment: "production" | "sandbox"
  store: "app_store" | "play_store"
  productId: string
  status: string
  autoRenewalStatus: string
  givesAccess: boolean
  // Actual verified expiry, including an explicitly verified store grace period.
  // No indefinite access or invented grace period on provider failure.
  accessThrough: string | null
}

function text(value: unknown, maximum = 255): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value)
}

/** Called inside the caller's authorised household write transaction. The
 * opaque UUID is also the identified RevenueCat customer ID; never use emails
 * or create anonymous purchase identities. */
export async function ensureNativeBillingAccount(client: Pick<Pool, "query">, householdId: string, projectId: string,
  environment: NativeBillingAccount["environment"]): Promise<NativeBillingAccount> {
  if (!text(projectId) || !["production", "sandbox"].includes(environment)) throw new NativeBillingError("configuration_mismatch")
  await client.query(`insert into native_billing_accounts(household_id, project_id, environment)
    values($1::uuid,$2,$3) on conflict (household_id,environment) do nothing`, [householdId, projectId, environment])
  const result = await client.query<NativeBillingAccount>(`select id,household_id,project_id,environment
    from native_billing_accounts where household_id=$1::uuid and environment=$2`, [householdId, environment])
  const account = result.rows[0]
  if (!account || account.project_id !== projectId) throw new NativeBillingError("configuration_mismatch")
  return account
}

/** Reserve a database revision BEFORE fetching provider state. No database
 * transaction/household lock is held during the network request. */
export async function beginNativeBillingVerification(pool: Pick<Pool, "query">, accountId: string) {
  const result = await pool.query<NativeBillingAccount & { revision: string }>(`update native_billing_accounts
    set requested_revision=requested_revision+1 where id=$1::uuid and household_id is not null
    returning id,household_id,project_id,environment,requested_revision::text as revision`, [accountId])
  if (!result.rows[0]) throw new NativeBillingError("account_retired")
  return result.rows[0]
}

function validateSnapshot(account: NativeBillingAccount, subscriptions: VerifiedNativeSubscription[]) {
  if (!Array.isArray(subscriptions) || subscriptions.length > 2000) throw new NativeBillingError("invalid_snapshot")
  const ids = new Set<string>()
  for (const item of subscriptions) {
    if (!item || !text(item.id) || ids.has(item.id) || !text(item.productId) || !text(item.status, 80) || !text(item.autoRenewalStatus, 80) ||
      !["app_store", "play_store"].includes(item.store) || typeof item.givesAccess !== "boolean" ||
      (item.accessThrough !== null && (typeof item.accessThrough !== "string" || !Number.isFinite(Date.parse(item.accessThrough)))) ||
      (item.givesAccess && !item.accessThrough)) throw new NativeBillingError("invalid_snapshot")
    if (item.originalCustomerId !== account.id || item.environment !== account.environment) throw new NativeBillingError("identity_mismatch")
    ids.add(item.id)
  }
}

/** Replace a COMPLETE verified provider snapshot atomically. A timeout or
 * partial pagination must never call this function. Missing subscriptions lose
 * access, but their original household binding remains for future restores. */
export async function applyNativeBillingSnapshot(pool: Pool, accountId: string, revision: string,
  subscriptions: VerifiedNativeSubscription[]) {
  if (!/^[1-9][0-9]{0,18}$/.test(revision)) throw new NativeBillingError("invalid_snapshot")
  const client = await pool.connect()
  try {
    await client.query("begin")
    await client.query("set local statement_timeout='5s'")
    const lookup = await client.query<NativeBillingAccount>("select * from native_billing_accounts where id=$1::uuid", [accountId])
    const account = lookup.rows[0]
    if (!account?.household_id) throw new NativeBillingError("account_retired")
    // Same lock as quota writes/Stripe reconciliation. The account row is read
    // again after acquiring it, so household deletion cannot revive access.
    const lock = await client.query<{ acquired: boolean }>("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired", [account.household_id])
    if (!lock.rows[0].acquired) throw new NativeBillingError("household_busy")
    const locked = await client.query<NativeBillingAccount & { requested_revision: string; applied_revision: string }>(
      "select * from native_billing_accounts where id=$1::uuid for update", [accountId])
    const current = locked.rows[0]
    if (!current?.household_id || current.household_id !== account.household_id) throw new NativeBillingError("account_retired")
    if (BigInt(revision) > BigInt(current.requested_revision)) throw new NativeBillingError("invalid_snapshot")
    if (BigInt(revision) <= BigInt(current.applied_revision)) {
      await client.query("commit")
      return { applied: false }
    }
    validateSnapshot(current, subscriptions)
    for (const item of [...subscriptions].sort((a, b) => a.id.localeCompare(b.id))) {
      const saved = await client.query(`insert into native_subscriptions
        (project_id,subscription_id,account_id,store,product_id,status,auto_renewal_status,gives_access,access_through,verified_at)
        values($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9::timestamptz,clock_timestamp())
        on conflict (project_id,subscription_id) do update set
          store=excluded.store, product_id=excluded.product_id, status=excluded.status,
          auto_renewal_status=excluded.auto_renewal_status, gives_access=excluded.gives_access,
          access_through=excluded.access_through, verified_at=excluded.verified_at
        where native_subscriptions.account_id=excluded.account_id`,
      [current.project_id,item.id,accountId,item.store,item.productId,item.status,item.autoRenewalStatus,item.givesAccess,item.accessThrough])
      if (!saved.rowCount) throw new NativeBillingError("purchase_already_bound")
    }
    await client.query(`update native_subscriptions set gives_access=false,access_through=null,status='not_returned',verified_at=clock_timestamp()
      where account_id=$1::uuid and not (subscription_id=any($2::text[]))`, [accountId, subscriptions.map(item => item.id)])
    await client.query(`update native_billing_accounts set applied_revision=$2::bigint,verified_at=clock_timestamp()
      where id=$1::uuid`, [accountId, revision])
    await client.query("commit")
    return { applied: true }
  } catch (error) { await client.query("rollback"); throw error }
  finally { client.release() }
}
