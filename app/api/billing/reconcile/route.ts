import { auth } from "@clerk/nextjs/server"
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { EntitlementError } from "@/lib/entitlements"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { billingOrigin,reconcileHouseholdSubscription } from "@/lib/stripe-billing"

export async function POST(request:Request) {
  try {
    const {userId} = await auth()
    if (!userId) throw new EntitlementError("Sign in required",401)
    if (request.headers.get("origin") !== billingOrigin()) throw new EntitlementError("Invalid origin")
    await enforceRequestLimit(userId,"billing")
    const body = await request.json()
    const householdId = String(body?.householdId ?? "")
    if (!/^[0-9a-f-]{36}$/i.test(householdId)) throw new EntitlementError("Invalid household",400)
    const household = await db.query("select 1 from households where id=$1::uuid and leader_id=$2",[householdId,userId])
    if (!household.rowCount) throw new EntitlementError("Only the household owner can refresh billing")
    await reconcileHouseholdSubscription(householdId)
    return NextResponse.json({ok:true})
  } catch(error) {
    return NextResponse.json({error:error instanceof EntitlementError ? error.message : "Billing status could not be refreshed. Please retry."},
      {status:error instanceof EntitlementError ? error.status : 503})
  }
}
