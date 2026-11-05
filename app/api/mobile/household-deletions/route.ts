import { auth } from "@clerk/nextjs/server"
import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { db } from "@/lib/db"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { EntitlementError } from "@/lib/entitlements"
import { listHouseholdDeletions } from "@/lib/household-deletion"

export const dynamic = "force-dynamic"
async function handleGET() {
  const { userId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 })
  try {
    await enforceRequestLimit(userId, "read")
    return Response.json({ accountId: userId, receipts: await listHouseholdDeletions(db, userId) }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    if (error instanceof EntitlementError) return Response.json({ error: error.message }, { status: error.status })
    return Response.json({ error: "Unable to check household deletion. Please try again." }, { status: 503 })
  }
}
export function GET(request: Request) { return withNativeKioskRequest(request, handleGET) }
