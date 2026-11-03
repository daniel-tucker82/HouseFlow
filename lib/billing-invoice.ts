import type Stripe from "stripe"

/** Entitlement follows the invoiced service period, never a later unpaid subscription period. */
export function paidInvoicePeriodEnd(invoice:Stripe.Invoice, subscriptionId:string, priceIds:ReadonlySet<string>) {
  if (invoice.status !== "paid" || invoice.amount_remaining !== 0) return null
  let end = 0
  for (const line of invoice.lines.data) {
    const details = line.parent?.subscription_item_details
    const price = line.pricing?.price_details?.price
    const priceId = typeof price === "string" ? price : price?.id
    if (details?.subscription !== subscriptionId || !priceId || !priceIds.has(priceId) || line.amount < 0) continue
    end = Math.max(end,line.period.end)
  }
  return end > 0 ? new Date(end * 1000) : null
}
