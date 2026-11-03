import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { auth } from "@clerk/nextjs/server"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { billingOrigin, stripeClient, validatedPrice } from "@/lib/stripe-billing"
import { EntitlementError, withHouseholdWrite } from "@/lib/entitlements"

async function handlePOST(request: Request) {
  try {
    const { userId } = await auth()
    if (!userId) throw new EntitlementError("Sign in required", 401)
    await enforceRequestLimit(userId,"billing")
    const origin = billingOrigin()
    if (request.headers.get("origin") !== origin) throw new EntitlementError("Invalid request origin")
    const body = await request.json()
    const householdId = String(body?.householdId ?? "")
    if (!["monthly", "yearly"].includes(body?.interval)) throw new EntitlementError("Choose monthly or yearly billing", 400)
    const price = await validatedPrice(body.interval)
    const result = await withHouseholdWrite(householdId, userId, async (client, entitlement) => {
      if (entitlement.leaderId !== userId) throw new EntitlementError("Only the household owner can manage billing")
      if (entitlement.tier !== "free") throw new EntitlementError("This household already has Premium access", 409)
      const stripe = stripeClient()
      await client.query("insert into household_billing (household_id) values ($1::uuid) on conflict do nothing", [householdId])
      const billing = await client.query("select stripe_customer_id from household_billing where household_id = $1::uuid", [householdId])
      let customer = billing.rows[0].stripe_customer_id as string | null
      if (!customer) {
        customer = (await stripe.customers.create({ metadata: { household_id: householdId, app: "cyntch" } }, { idempotencyKey: `cyntch-customer-${householdId}` })).id
        await client.query("update household_billing set stripe_customer_id = $2 where household_id = $1::uuid", [householdId, customer])
      }
      const subscriptions = await stripe.subscriptions.list({ customer, status: "all", limit: 100 })
      if (subscriptions.data.some(sub => !["canceled", "incomplete_expired"].includes(sub.status))) {
        throw new EntitlementError("An existing subscription needs attention. Use Manage subscription.", 409)
      }
      const existing = await stripe.checkout.sessions.list({ customer, status: "open", limit: 10 })
      const reusable = existing.data.find(session => session.metadata?.household_id === householdId && session.metadata?.interval === body.interval)
      if (reusable?.url) return { url: reusable.url }
      for (const session of existing.data.filter(session => session.metadata?.household_id === householdId)) await stripe.checkout.sessions.expire(session.id)
      const session = await stripe.checkout.sessions.create({
        mode: "subscription", customer,
        line_items: [{ price: price.id, quantity: 1 }],
        client_reference_id: householdId,
        metadata: { household_id: householdId, interval: body.interval, app: "cyntch" },
        subscription_data: { metadata: { household_id: householdId, app: "cyntch" } },
        integration_identifier: `cyntch_${Array.from(randomBytes(8), n => String.fromCharCode(97 + n % 26)).join("")}`,
        success_url: `${origin}/settings/billing?household=${encodeURIComponent(householdId)}&checkout=complete`,
        cancel_url: `${origin}/settings/billing?household=${encodeURIComponent(householdId)}`,
      })
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
