import { NextResponse } from "next/server"
import type Stripe from "stripe"
import { db } from "@/lib/db"
import { reconcileHouseholdSubscription, stripeClient } from "@/lib/stripe-billing"

const handled = new Set([
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required", "invoice.voided",
  "charge.dispute.created", "charge.dispute.closed", "charge.refunded", "radar.early_fraud_warning.created",
])

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && "id" in value) return String(value.id)
  return null
}

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({error:"Webhook not configured"}, {status:503})
  let event: Stripe.Event
  try {
    const signature = request.headers.get("stripe-signature")
    if (!signature) throw new Error("Missing signature")
    event = stripeClient().webhooks.constructEvent(await request.text(), signature, secret)
    const liveKey = /^[sr]k_live_/.test(process.env.STRIPE_SECRET_KEY ?? "")
    if (event.livemode !== liveKey) throw new Error("Wrong billing environment")
  } catch { return NextResponse.json({error:"Invalid webhook"}, {status:400}) }
  if (!handled.has(event.type)) return NextResponse.json({received:true})
  try {
    await db.query(`insert into billing_webhook_events (event_id, event_type, stripe_created_at)
      values ($1,$2,to_timestamp($3)) on conflict do nothing`, [event.id,event.type,event.created])
    const receipt = await db.query("select processed_at from billing_webhook_events where event_id = $1", [event.id])
    if (receipt.rows[0]?.processed_at) return NextResponse.json({received:true})
    await db.query("update billing_webhook_events set attempts = attempts + 1 where event_id = $1", [event.id])
    const object = event.data.object as unknown as Record<string, unknown>
    let customer = objectId(object.customer)
    let charge: Stripe.Charge | null = null
    if (event.type.startsWith("charge.dispute.") || event.type === "radar.early_fraud_warning.created") {
      const id = objectId(object.charge)
      if (id) { charge = await stripeClient().charges.retrieve(id); customer = objectId(charge.customer) }
    }
    if (event.type === "charge.refunded") {
      charge = await stripeClient().charges.retrieve(String(object.id))
      customer = objectId(charge.customer)
    }
    if (customer) {
      const lookup = await db.query("select household_id,stripe_subscription_id,paid_through from household_billing where stripe_customer_id = $1", [customer])
      const householdId = lookup.rows[0]?.household_id as string | undefined
      if (householdId) {
        const risk = event.type.startsWith("charge.") || event.type.startsWith("radar.")
        if (risk) {
          await db.query(`insert into billing_risk_events (event_id,household_id,event_type,stripe_object_id)
            values ($1,$2::uuid,$3,$4) on conflict do nothing`, [event.id,householdId,event.type,String(object.id)])
          // Read current dispute state so replayed creation events cannot reinstate a won dispute.
          if (event.type.startsWith("charge.dispute.")) {
            const dispute = await stripeClient().disputes.retrieve(String(object.id))
            const hold = "dispute:" + dispute.id
            if (dispute.status === "won" || dispute.status === "warning_closed") {
              await db.query("update household_billing set billing_hold=null,updated_at=now() where household_id=$1::uuid and billing_hold=$2",[householdId,hold])
              await db.query("update billing_risk_events set resolved_at=now() where stripe_object_id=$1",[dispute.id])
            } else if (["needs_response","under_review","lost"].includes(dispute.status)) {
              await db.query("update household_billing set billing_hold=$2,updated_at=now() where household_id=$1::uuid",[householdId,hold])
            }
          }
          // Refunding an old period must not revoke a newer paid period.
          const paymentIntent = objectId(charge?.payment_intent)
          if (event.type === "charge.refunded" && charge?.refunded && paymentIntent) {
            const payments = await stripeClient().invoicePayments.list({payment:{type:"payment_intent",payment_intent:paymentIntent},limit:10})
            for (const payment of payments.data) {
              const invoiceId = objectId(payment.invoice)
              if (!invoiceId) continue
              const invoice = await stripeClient().invoices.retrieve(invoiceId)
              if (objectId(invoice.parent?.subscription_details?.subscription) !== lookup.rows[0].stripe_subscription_id) continue
              const end = Math.max(...invoice.lines.data.map(line=>line.period.end),0) * 1000
              if (end > Date.now() && end >= new Date(lookup.rows[0].paid_through ?? 0).getTime()) {
                await db.query("update household_billing set billing_hold=$2,updated_at=now() where household_id=$1::uuid and (billing_hold is null or billing_hold like 'refund:%')",[householdId,"refund:" + invoiceId])
              }
            }
          }
          console.warn("Billing risk event needs review", {eventId:event.id, householdId, kind:event.type})
        }
        await reconcileHouseholdSubscription(householdId)
      }
    }
    await db.query("update billing_webhook_events set processed_at = now(), last_error = null where event_id = $1", [event.id])
    return NextResponse.json({received:true})
  } catch {
    await db.query("update billing_webhook_events set last_error = 'Reconciliation failed; retry required' where event_id = $1", [event.id]).catch(() => {})
    return NextResponse.json({error:"Retry required"}, {status:503})
  }
}
