import { randomUUID } from "node:crypto"
import { db } from "@/lib/db"
import { withHouseholdWrite, EntitlementError } from "@/lib/entitlements"
import { nativeBillingEnvironment } from "@/lib/billing-access"
import { activeBillingPurchase, BillingPurchaseError, reserveBillingPurchase, type BillingAttemptIdentity } from "@/lib/billing-purchase-attempts"
import { revenueCatConfig, verifyNativeBillingAccount } from "@/lib/revenuecat-native-billing"

/** Commit a reservation before any external create call. If the request dies
 * after Stripe accepted checkout, the next request uses the same idempotency key.
 * Feature-off deployments retain the original web path without new table reads. */
export async function reserveWebBillingCheckout(householdId: string, userId: string, sessionId: string | null | undefined,
  interval: "monthly" | "yearly"): Promise<BillingAttemptIdentity | null> {
  const environment = nativeBillingEnvironment()
  if (!environment) return null
  if (!sessionId) throw new EntitlementError("Sign in again before starting checkout.", 401)
  const config = revenueCatConfig()
  if (!config) throw new EntitlementError("Store billing needs configuration.", 503)
  const identity = await withHouseholdWrite(householdId, userId, async (client, entitlement) => {
    if (entitlement.leaderId !== userId) throw new EntitlementError("Only the household owner can manage billing")
    if (entitlement.tier !== "free") throw new EntitlementError("This household already has Premium access", 409)
    const current = await activeBillingPurchase(client, householdId, environment)
    if (current && (current.provider !== "stripe" || current.user_id !== userId || current.session_id !== sessionId || current.billing_interval !== interval)) {
      throw new BillingPurchaseError("purchase_in_progress", "A subscription purchase is already in progress. Finish it before starting another.")
    }
    const value: BillingAttemptIdentity = { id: current?.id ?? randomUUID(), householdId, userId, sessionId, deviceId: null, provider: "stripe", interval, environment }
    await reserveBillingPurchase(client, value)
    return value
  })
  // Merely opening store settings can reserve an identity before the SDK ever
  // creates its provider customer. Only purchase/restore activity needs a fetch.
  const account = (await db.query(`select a.id from native_billing_accounts a where a.household_id=$1::uuid and a.environment=$2
    and (a.verified_at is not null or exists(select 1 from native_billing_jobs j where j.account_id=a.id)
      or exists(select 1 from billing_purchase_attempts p where p.household_id=a.household_id and p.environment=a.environment and p.provider<>'stripe'))`, [householdId,environment])).rows[0]
  if (account) await verifyNativeBillingAccount(db, account.id, config)
  return identity
}
