import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { auth } from "@clerk/nextjs/server"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { billingOrigin, stripeClient, validatedPrice } from "@/lib/stripe-billing"
import { EntitlementError, withHouseholdWrite } from "@/lib/entitlements"
import { nativeBillingEnvironment } from "@/lib/billing-access"
import { assertNoNativeSubscription, requireBillingPurchase } from "@/lib/billing-purchase-attempts"
import { reserveWebBillingCheckout } from "@/lib/web-billing-reservation"

async function handlePOST(request: Request) {
  try {
    const { userId, sessionId } = await auth()
    if (!userId) throw new EntitlementError("Sign in required", 401)
    await enforceRequestLimit(userId,"billing")
    const origin = billingOrigin()
    if (request.headers.get("origin") !== origin) throw new EntitlementError("Invalid request origin")
    const body = await request.json()
    const householdId = String(body?.householdId ?? "").toLowerCase()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(householdId)) throw new EntitlementError("Choose a household", 400)
    if (!["monthly", "yearly"].includes(body?.interval)) throw new EntitlementError("Choose monthly or yearly billing", 400)
    const price = await validatedPrice(body.interval)
    const reservation = await reserveWebBillingCheckout(householdId, userId, sessionId, body.interval)
    // Commit the customer binding before creating a checkout. A lost checkout
    // response must not roll back the only link deletion/recovery can follow.
    const customer = await withHouseholdWrite(householdId, userId, async (client, entitlement) => {
      if (entitlement.leaderId !== userId) throw new EntitlementError("Only the household owner can manage billing")
      if (entitlement.tier !== "free") throw new EntitlementError("This household already has Premium access", 409)
      if(reservation) await requireBillingPurchase(client,reservation)
      const environment = nativeBillingEnvironment()
      if (environment) await assertNoNativeSubscription(client, householdId, environment)
      const stripe = stripeClient()
      await client.query("insert into household_billing (household_id) values ($1::uuid) on conflict do nothing", [householdId])
      const billing = await client.query("select stripe_customer_id,stripe_customer_retired,stripe_customer_deleted_at,stripe_customer_generation,billing_hold from household_billing where household_id = $1::uuid", [householdId])
      const prior=billing.rows[0]
      if(prior.stripe_customer_retired && (!prior.stripe_customer_deleted_at || prior.billing_hold)) throw new EntitlementError("The former owner's billing account still needs attention. Please try again later.",409)
      const generation=Number(prior.stripe_customer_generation ?? 0)+(prior.stripe_customer_retired?1:0)
      let customer = (prior.stripe_customer_retired?null:prior.stripe_customer_id) as string | null
      if (!customer) {
        customer = (await stripe.customers.create({ metadata: { household_id: householdId, app: "cyntch" } }, { idempotencyKey: `cyntch-customer-${householdId}${generation?`-${generation}`:''}` })).id
        await client.query(`update household_billing set stripe_customer_id=$2,stripe_customer_generation=$3,
          stripe_subscription_id=case when stripe_customer_retired then null else stripe_subscription_id end,
          subscription_status=case when stripe_customer_retired then 'none' else subscription_status end,
          paid_through=case when stripe_customer_retired then null else paid_through end,
          cancel_at_period_end=case when stripe_customer_retired then false else cancel_at_period_end end,
          stripe_customer_retired=false,stripe_customer_deleted_at=null where household_id=$1::uuid`,[householdId,customer,generation])
      }
      return customer
    })
    const result = await withHouseholdWrite(householdId,userId,async(client,entitlement)=>{
      if(entitlement.leaderId!==userId) throw new EntitlementError("Only the household owner can manage billing")
      if(entitlement.tier!=="free") throw new EntitlementError("This household already has Premium access",409)
      const binding=(await client.query("select stripe_customer_id,stripe_customer_retired from household_billing where household_id=$1",[householdId])).rows[0]
      if(binding?.stripe_customer_id!==customer || binding.stripe_customer_retired) throw new EntitlementError("The household's billing account changed. Please try again.",409)
      const attempt=reservation?await requireBillingPurchase(client,reservation):null
      const environment=nativeBillingEnvironment()
      if(environment) await assertNoNativeSubscription(client,householdId,environment)
      const stripe=stripeClient()
      const subscriptions = await stripe.subscriptions.list({ customer, status: "all", limit: 100 })
      if (subscriptions.has_more || subscriptions.data.some(sub => !["canceled", "incomplete_expired"].includes(sub.status))) {
        throw new EntitlementError("An existing subscription needs attention. Use Manage subscription.", 409)
      }
      const existing = await stripe.checkout.sessions.list({ customer, status: "open", limit: 100 })
      if (existing.has_more) throw new EntitlementError("Existing checkouts need attention before another subscription can start.", 409)
      const reusable = existing.data.find(session => session.metadata?.household_id === householdId && session.metadata?.interval === body.interval)
      if (reusable?.url) {
        if (attempt) await client.query("update billing_purchase_attempts set expires_at=to_timestamp($2),updated_at=now() where id=$1::uuid", [attempt.id,reusable.expires_at])
        return { url: reusable.url }
      }
      for (const session of existing.data.filter(session => session.metadata?.household_id === householdId)) await stripe.checkout.sessions.expire(session.id)
      // Stripe requires at least 30 minutes. Keep the original expiry and all
      // create parameters stable for retries of this attempt's idempotency key.
      if (attempt && attempt.expires_at.getTime() - Date.now() < 31 * 60_000) throw new EntitlementError("This checkout attempt is ending. Please try again after it expires.", 409)
      const session = await stripe.checkout.sessions.create({
        mode: "subscription", customer,
        line_items: [{ price: price.id, quantity: 1 }],
        client_reference_id: householdId,
        metadata: { household_id: householdId, interval: body.interval, app: "cyntch" },
        subscription_data: { metadata: { household_id: householdId, app: "cyntch" } },
        integration_identifier: `cyntch_${attempt?.integration_suffix ?? Array.from(randomBytes(8), n => String.fromCharCode(97 + n % 26)).join("")}`,
        ...(attempt ? { expires_at: Math.floor(attempt.expires_at.getTime() / 1000) } : {}),
        success_url: `${origin}/settings/billing?household=${encodeURIComponent(householdId)}&checkout=complete`,
        cancel_url: `${origin}/settings/billing?household=${encodeURIComponent(householdId)}`,
      }, attempt ? { idempotencyKey: `cyntch-checkout-${attempt.id}` } : undefined)
      return { url: session.url }
    })
    return NextResponse.json(result)
  } catch(error) {
    if (error instanceof EntitlementError) return NextResponse.json({error:error.message}, {status:error.status})
    console.error("Checkout could not be created")
    return NextResponse.json({error:"Unable to start checkout. Please try again."}, {status:503})
  }
}

export function POST(request: Request) { return withNativeKioskRequest(request, handlePOST) }
