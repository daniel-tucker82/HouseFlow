import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { auth } from "@clerk/nextjs/server"
import { acceptInviteByCode } from "@/lib/actions/household"
import { ensureCurrentUserRecord } from "@/lib/user-sync"
import { db } from "@/lib/db"
import { EntitlementError } from "@/lib/entitlements"
import { TermsConsentError } from "@/lib/terms-consent"

async function handlePOST(request: Request) {
  const { userId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json().catch(() => null)
  if (typeof body?.code !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.code)) {
    return Response.json({ error: "Enter a valid invitation code or link." }, { status: 400 })
  }
  try {
    await ensureCurrentUserRecord()
    await acceptInviteByCode(body.code, userId)
    const result = await db.query<{ household_id: string }>(
      `select hi.household_id from household_invites hi
       join household_members hm on hm.household_id = hi.household_id and hm.user_id = $2
       where hi.code = $1`, [body.code, userId])
    return Response.json({ householdId: result.rows[0]?.household_id })
  } catch (error) {
    if (error instanceof TermsConsentError) return Response.json({ error: error.message, code: "terms_acceptance_required" }, { status: error.status })
    if (error instanceof EntitlementError) return Response.json({ error: error.message }, { status: error.status })
    // The shared join action uses these public messages; database/internal errors stay private.
    const message = error instanceof Error ? error.message : ""
    if (["Invite not found.", "Invite has expired or is inactive.", "Invite code is required."].includes(message)) {
      return Response.json({ error: message }, { status: 400 })
    }
    console.error("[mobile-join] Unable to accept invitation", { error })
    return Response.json({ error: "Unable to join the household right now. Please try again." }, { status: 503 })
  }
}

export function POST(request: Request) { return withNativeKioskRequest(request, handlePOST) }
