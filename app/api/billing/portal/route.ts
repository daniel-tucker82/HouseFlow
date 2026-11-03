import { auth } from "@clerk/nextjs/server"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { NextResponse } from "next/server"
import { billingOrigin, stripeClient } from "@/lib/stripe-billing"
import { EntitlementError, withHouseholdWrite } from "@/lib/entitlements"

export async function POST(request: Request) {
  try {
    const { userId } = await auth()
    if (!userId) throw new EntitlementError("Sign in required", 401)
    await enforceRequestLimit(userId,"billing")
    const origin = billingOrigin()
    if (request.headers.get("origin") !== origin) throw new EntitlementError("Invalid request origin")
    const body = await request.json()
    const householdId = String(body?.householdId ?? "")
    const result = await withHouseholdWrite(householdId, userId, async (client, entitlement) => {
      if (entitlement.leaderId !== userId) throw new EntitlementError("Only the household owner can manage billing")
      const billing = await client.query("select stripe_customer_id from household_billing where household_id = $1::uuid", [householdId])
      const customer = billing.rows[0]?.stripe_customer_id
      if (!customer) throw new EntitlementError("No billing account exists for this household", 404)
      const session = await stripeClient().billingPortal.sessions.create({customer, return_url: `${origin}/settings/billing?household=${encodeURIComponent(householdId)}`})
      return {url:session.url}
    })
    return NextResponse.json(result)
  } catch(error) {
    if (error instanceof EntitlementError) return NextResponse.json({error:error.message}, {status:error.status})
    return NextResponse.json({error:"Unable to open subscription management. Please try again."}, {status:503})
  }
}
