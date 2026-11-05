import { auth } from "@clerk/nextjs/server"
import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { EntitlementError } from "@/lib/entitlements"
import { InvitationReadError, readMobileInvitations } from "@/lib/mobile-invitations"

export const dynamic = "force-dynamic"
async function handleGET(request: Request) {
  const { userId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 })
  try {
    await enforceRequestLimit(userId, "read")
    return Response.json(await readMobileInvitations(userId, new URL(request.url).searchParams), { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof InvitationReadError || error instanceof EntitlementError) return Response.json({ error: error.message }, { status: error.status })
    console.error("[mobile-invitations] Unable to read invitations", { error })
    return Response.json({ error: "Unable to load invitations. Please try again." }, { status: 503 })
  }
}
export function GET(request: Request) { return withNativeKioskRequest(request, handleGET) }
