import type { PoolClient } from "pg"
import { db } from "@/lib/db"
import { EntitlementError, getHouseholdEntitlement, withHouseholdWrite } from "@/lib/entitlements"
import { nativeBillingEnvironment } from "@/lib/billing-access"
import { ensureNativeBillingAccount } from "@/lib/native-billing-store"
import { enqueueNativeBillingAccount } from "@/lib/native-billing-jobs"
import { revenueCatConfig, verifyNativeBillingAccount, type RevenueCatConfig } from "@/lib/revenuecat-native-billing"
import { stripeClient } from "@/lib/stripe-billing"
import { assertNoNativeSubscription, BillingPurchaseError, releaseBillingPurchase, reserveBillingPurchase,
  submitNativeBillingPurchase, type BillingAttemptIdentity, type BillingPurchaseAttempt } from "@/lib/billing-purchase-attempts"
import type { NativeBillingAction, NativeBillingScope, NativeBillingSetup, NativeBillingSource, NativeBillingStatus, NativeBillingStore } from "@/shared/mobile/billing"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function billingUuid(value: unknown): value is string { return typeof value === "string" && uuid.test(value) }
export function parseNativeBillingAction(value: unknown): NativeBillingAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new EntitlementError("Choose a billing action.", 400)
  const body = value as Record<string, unknown>
  if (!billingUuid(body.householdId) || !["prepare", "begin", "cancel", "verify", "webCancellation"].includes(String(body.action))) throw new EntitlementError("Choose a household and billing action.", 400)
  if (!["verify","webCancellation"].includes(String(body.action)) && !["app_store", "play_store"].includes(String(body.store))) throw new EntitlementError("Choose a supported store.", 400)
  if (["begin", "cancel"].includes(String(body.action)) &&
    (!billingUuid(body.operationId) || !["monthly", "yearly"].includes(String(body.interval)))) throw new EntitlementError("Choose a subscription and purchase attempt.", 400)
  return { ...body, householdId: body.householdId.toLowerCase(), ...(typeof body.operationId === "string" ? { operationId: body.operationId.toLowerCase() } : {}) } as NativeBillingAction
}

function configured() {
  const config = revenueCatConfig()
  if (!config) throw new EntitlementError("Store subscriptions are not available yet.", 503)
  return config
}
function publicKey(store: NativeBillingStore) {
  const key = store === "app_store" ? process.env.REVENUECAT_IOS_PUBLIC_KEY : process.env.REVENUECAT_ANDROID_PUBLIC_KEY
  if (!key || !(store === "app_store" ? /^appl_[a-zA-Z0-9]+$/ : /^goog_[a-zA-Z0-9]+$/).test(key)) {
    throw new EntitlementError("Store subscriptions are not configured yet.", 503)
  }
  return key
}
function owner(scope: NativeBillingScope, entitlement: Awaited<ReturnType<typeof getHouseholdEntitlement>>) {
  if (entitlement.leaderId !== scope.accountId) throw new EntitlementError("Only the household owner can manage billing.")
}
function free(entitlement: Awaited<ReturnType<typeof getHouseholdEntitlement>>) {
  if (entitlement.tier !== "free") throw new BillingPurchaseError("existing_subscription", "This household already has Premium access.")
}
function iso(value: Date | string | null) { return value === null ? null : new Date(value).toISOString() }

/** Reading a plan needs membership, not management rights. Provider details and
 * in-progress purchase identities are returned only to the household owner. */
export async function readNativeBillingStatus(scope: NativeBillingScope): Promise<NativeBillingStatus> {
  const client = await db.connect()
  try {
    const membership = await client.query("select 1 from household_members where household_id=$1::uuid and user_id=$2", [scope.householdId,scope.accountId])
    if (!membership.rowCount) throw new EntitlementError("Household access required.")
    const entitlement = await getHouseholdEntitlement(client, scope.householdId), canManage = entitlement.leaderId === scope.accountId
    let purchasesAvailable = false
    try { purchasesAvailable = Boolean(revenueCatConfig() && publicKey("app_store") && publicKey("play_store")) } catch { /* A misconfigured store cannot offer a purchase. */ }
    const result: NativeBillingStatus = { ...scope, tier: entitlement.tier, limits: entitlement.limits, canManage,
      purchasesAvailable: canManage && purchasesAvailable, sources: [], duplicateSubscriptions: false, verificationPending: false, purchase: null }
    if (!canManage) return result
    const billing = (await client.query(`select subscription_status,paid_through,cancel_at_period_end,billing_hold,
      stripe_subscription_id from household_billing where household_id=$1::uuid`, [scope.householdId])).rows[0]
    if (billing?.stripe_subscription_id) result.sources.push({ provider: "stripe", status: billing.subscription_status,
      givesAccess: !billing.billing_hold && ["active","past_due","canceled"].includes(billing.subscription_status) && new Date(billing.paid_through ?? 0).getTime() > Date.now(),
      accessThrough: iso(billing.paid_through), renewal: billing.cancel_at_period_end ? "will_not_renew" : "managed_by_provider",
      pendingPayment: ["incomplete","past_due","unpaid"].includes(billing.subscription_status) })
    const environment = nativeBillingEnvironment()
    if (environment) {
      const subscriptions = await client.query(`select s.store,s.status,s.gives_access,s.access_through,s.pending_payment,s.auto_renewal_status
        from native_subscriptions s join native_billing_accounts a on a.id=s.account_id
        where a.household_id=$1::uuid and a.environment=$2 order by s.store,s.subscription_id`, [scope.householdId,environment])
      result.sources.push(...subscriptions.rows.map(row => ({ provider: row.store, status: row.status,
        givesAccess: row.gives_access && new Date(row.access_through ?? 0).getTime() > Date.now(),
        accessThrough: iso(row.access_through), pendingPayment: row.pending_payment, renewal: row.auto_renewal_status } as NativeBillingSource)))
      const jobs = await client.query(`select 1 from native_billing_jobs j join native_billing_accounts a on a.id=j.account_id
        where a.household_id=$1::uuid and a.environment=$2 and (j.requested_generation>j.completed_generation or j.last_error_code is not null)`, [scope.householdId,environment])
      result.verificationPending = Boolean(jobs.rowCount)
      const attempt = (await client.query<BillingPurchaseAttempt>(`select * from billing_purchase_attempts
        where household_id=$1::uuid and environment=$2 and state in ('reserved','submitted') and expires_at>now()`, [scope.householdId,environment])).rows[0]
      if (attempt) {
        const thisSession = attempt.user_id === scope.accountId && attempt.session_id === scope.sessionId && attempt.device_id === scope.deviceId
        result.purchase = { id: thisSession ? attempt.id : null, provider: attempt.provider, interval: attempt.billing_interval,
          expiresAt: attempt.expires_at.toISOString(), thisSession }
      }
    }
    result.duplicateSubscriptions = result.sources.filter(source => source.givesAccess).length > 1
    return result
  } finally { client.release() }
}

export async function prepareNativeBilling(scope: NativeBillingScope, store: NativeBillingStore): Promise<NativeBillingSetup> {
  const config = configured(), publicSdkKey = publicKey(store)
  const account = await withHouseholdWrite(scope.householdId, scope.accountId, async (client, entitlement) => {
    owner(scope, entitlement)
    return ensureNativeBillingAccount(client, scope.householdId, config.projectId, config.environment)
  })
  return { ...scope, billingCustomerId: account.id, publicSdkKey, environment: config.environment, store,
    products: config.products.filter(product => product.store === store).map(({ interval, storeProductId }) => ({ interval, storeProductId })) }
}

/** Bounded, fresh Stripe check, outside the household write transaction. The
 * durable reservation prevents Cyntch's web checkout from racing this request. */
export async function assertNoStripePurchase(householdId: string) {
  const billing = (await db.query("select stripe_customer_id from household_billing where household_id=$1::uuid", [householdId])).rows[0]
  if (!billing?.stripe_customer_id) return
  const stripe = stripeClient(), options = { timeout: 8_000, maxNetworkRetries: 0 }
  const [subscriptions, checkouts] = await Promise.all([
    stripe.subscriptions.list({ customer: billing.stripe_customer_id, status: "all", limit: 100 }, options),
    stripe.checkout.sessions.list({ customer: billing.stripe_customer_id, status: "open", limit: 100 }, options),
  ])
  // Refuse an incomplete snapshot. The management flow can resolve old records.
  if (subscriptions.has_more || subscriptions.data.some(sub => !["canceled","incomplete_expired"].includes(sub.status))) {
    throw new BillingPurchaseError("existing_subscription", "An existing web subscription needs attention. Manage it before starting another subscription.")
  }
  if (checkouts.has_more || checkouts.data.some(session => session.mode === "subscription")) {
    throw new BillingPurchaseError("purchase_in_progress", "A web subscription checkout is still open for this household. Finish or close it before starting another purchase.")
  }
}

function identity(scope: NativeBillingScope, action: Extract<NativeBillingAction, { action: "begin" | "cancel" }>, environment: "production" | "sandbox"): BillingAttemptIdentity {
  return { id: action.operationId, householdId: scope.householdId, userId: scope.accountId, sessionId: scope.sessionId,
    deviceId: scope.deviceId, provider: action.store, interval: action.interval, environment }
}

export async function beginNativeBillingPurchase(scope: NativeBillingScope, action: Extract<NativeBillingAction, { action: "begin" | "cancel" }>) {
  const config = configured(); publicKey(action.store)
  const attemptIdentity = identity(scope, action, config.environment)
  const account = await withHouseholdWrite(scope.householdId, scope.accountId, async (client, entitlement) => {
    owner(scope, entitlement); free(entitlement)
    await reserveBillingPurchase(client, attemptIdentity)
    const account = await ensureNativeBillingAccount(client, scope.householdId, config.projectId, config.environment)
    await enqueueNativeBillingAccount(client, account.id)
    return account
  })
  // The SDK must identify this customer before begin. A provider failure, even
  // a missing customer, fails closed; no client receipt can bypass verification.
  await Promise.all([verifyNativeBillingAccount(db, account.id, config), assertNoStripePurchase(scope.householdId)])
  const attempt = await withHouseholdWrite(scope.householdId, scope.accountId, async (client, entitlement) => {
    owner(scope, entitlement); free(entitlement)
    await assertNoNativeSubscription(client, scope.householdId, config.environment)
    const attempt = await submitNativeBillingPurchase(client, attemptIdentity)
    await enqueueNativeBillingAccount(client, account.id)
    return attempt
  })
  return { ...scope, operationId: attempt.id, expiresAt: attempt.expires_at.toISOString() }
}

export async function cancelNativeBillingPurchase(scope: NativeBillingScope, action: Extract<NativeBillingAction, { action: "begin" | "cancel" }>) {
  const config = configured()
  await withHouseholdWrite(scope.householdId, scope.accountId, async (client, entitlement) => {
    owner(scope, entitlement)
    await releaseBillingPurchase(client, identity(scope, action, config.environment))
    await enqueueHouseholdVerification(client, scope.householdId)
  })
  return { ...scope, operationId: action.operationId }
}

async function enqueueHouseholdVerification(client: PoolClient, householdId: string, config: RevenueCatConfig = configured()) {
  const account = (await client.query("select id from native_billing_accounts where household_id=$1::uuid and project_id=$2 and environment=$3",
    [householdId,config.projectId,config.environment])).rows[0]
  if (!account) throw new EntitlementError("Connect to the store before refreshing purchases.", 409)
  await enqueueNativeBillingAccount(client, account.id)
}

/** Purchase/restore callbacks enqueue verification only. A committed retry job
 * survives app termination, lost responses and unavailable providers. */
export async function requestNativeBillingVerification(scope: NativeBillingScope) {
  const config = configured()
  await withHouseholdWrite(scope.householdId, scope.accountId, async (client, entitlement) => {
    owner(scope, entitlement)
    await enqueueHouseholdVerification(client, scope.householdId, config)
  })
  return readNativeBillingStatus(scope)
}
