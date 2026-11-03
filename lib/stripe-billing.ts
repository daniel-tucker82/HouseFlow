import Stripe from "stripe"
import { db } from "@/lib/db"
import { EntitlementError } from "@/lib/entitlements"
import { SUBSCRIPTION_PRICES } from "@/lib/billing-policy"
import { paidInvoicePeriodEnd } from "@/lib/billing-invoice"

export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new EntitlementError("Billing is not configured yet.", 503)
  return new Stripe(key, { maxNetworkRetries: 2, timeout: 15000 })
}

export function billingOrigin() {
  const origin = process.env.NEXT_PUBLIC_APP_URL
  if (!origin) throw new EntitlementError("Application URL is not configured.", 503)
  const url = new URL(origin)
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") throw new EntitlementError("Billing requires HTTPS.", 503)
  return url.origin
}

export async function validatedPrice(interval: "monthly" | "yearly") {
  const id = interval === "monthly" ? process.env.STRIPE_MONTHLY_PRICE_ID : process.env.STRIPE_YEARLY_PRICE_ID
  if (!id) throw new EntitlementError("Subscription price is not configured.", 503)
  const price = await stripeClient().prices.retrieve(id)
  if (!price.active || price.currency !== "aud" || price.unit_amount !== SUBSCRIPTION_PRICES[interval] ||
      price.recurring?.interval !== (interval === "monthly" ? "month" : "year") || price.recurring.interval_count !== 1) {
    throw new EntitlementError("Subscription price configuration needs review.", 503)
  }
  return price
}

/** Re-fetch current Stripe state under the household lock: event timestamps never determine access. */
export async function reconcileHouseholdSubscription(householdId: string) {
  const client = await db.connect()
  try {
    await client.query("begin")
    const lock = await client.query("select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired", [householdId])
    if (!lock.rows[0].acquired) throw new EntitlementError("Household is busy; retry reconciliation.", 409)
    const record = await client.query("select * from household_billing where household_id = $1::uuid for update", [householdId])
    const billing = record.rows[0]
    if (!billing?.stripe_customer_id) { await client.query("commit"); return }
    const stripe = stripeClient()
    const subscriptions = await stripe.subscriptions.list({ customer: billing.stripe_customer_id, status: "all", limit: 100, expand: ["data.latest_invoice"] })
    const allowed = new Set([process.env.STRIPE_MONTHLY_PRICE_ID, process.env.STRIPE_YEARLY_PRICE_ID].filter((id): id is string => Boolean(id)))
    if (allowed.size !== 2) throw new EntitlementError("Both subscription prices must be configured.",503)
    const eligible = subscriptions.data.filter(sub => sub.metadata.household_id === householdId &&
      sub.items.data.length === 1 && allowed.has(sub.items.data[0].price.id) && sub.items.data[0].quantity === 1)
    const subscription = eligible.sort((a,b) => b.created - a.created)[0]
    if (!subscription) {
      await client.query("update household_billing set subscription_status='none',paid_through=null,last_reconciled_at=now(),updated_at=now() where household_id=$1::uuid",[householdId])
      await client.query("commit"); return
    }
    const sameSubscription = billing.stripe_subscription_id === subscription.id
    let paidThrough = sameSubscription ? billing.paid_through : null
    const paidInvoices = await stripe.invoices.list({subscription:subscription.id,status:"paid",limit:5})
    for (const invoice of paidInvoices.data) {
      const end = paidInvoicePeriodEnd(invoice,subscription.id,allowed)
      if (end && (!paidThrough || end.getTime() > new Date(paidThrough).getTime())) paidThrough = end
    }
    if (typeof billing.billing_hold === "string" && billing.billing_hold.startsWith("refund:")) {
      const refundedInvoice = await stripe.invoices.retrieve(billing.billing_hold.slice(7))
      const refundedEnd = Math.max(...refundedInvoice.lines.data.map(line=>line.period.end),0) * 1000
      if (paidThrough && new Date(paidThrough).getTime() > refundedEnd) {
        await client.query("update household_billing set billing_hold=null where household_id=$1::uuid",[householdId])
      }
    }
    await client.query(`update household_billing set stripe_subscription_id = $2, subscription_status = $3,
      paid_through = $4, cancel_at_period_end = $5, last_reconciled_at = now(), updated_at = now()
      where household_id = $1::uuid`, [householdId, subscription.id, subscription.status, paidThrough,
      // Flexible-mode portal cancellations set cancel_at, not cancel_at_period_end.
      subscription.cancel_at_period_end || subscription.cancel_at != null])
    await client.query("commit")
  } catch(error) { await client.query("rollback"); throw error }
  finally { client.release() }
}
