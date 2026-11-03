import { auth } from "@clerk/nextjs/server"
import { getHouseholdMemberViewData, getUserHouseholds } from "@/lib/data"
import { normalizeRole } from "@/lib/household-authz"
import { ensureCurrentUserRecord } from "@/lib/user-sync"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { EntitlementError } from "@/lib/entitlements"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const { userId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 })
  try {
    await enforceRequestLimit(userId, "read")
    await ensureCurrentUserRecord()
    const memberships = await getUserHouseholds(userId)
    const households = memberships.map(({ household, role }) => ({
      id: household.id, name: household.name, timezone: household.timezone ?? "UTC",
      leaderId: household.leader_id, role: normalizeRole(role),
    }))
    const householdId = new URL(request.url).searchParams.get("householdId")
    const selected = householdId ? households.find(h => h.id === householdId) : households[0]
    if (householdId && !selected) return Response.json({ error: "Household access is no longer available" }, { status: 403 })
    const board = selected ? await getHouseholdMemberViewData(selected.id, userId) : null
    return Response.json({ accountId: userId, households, board: selected && board ? {
      household: selected, members: board.members, tasks: board.tasks, fetchedAt: new Date().toISOString(),
    } : null }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof EntitlementError) return Response.json({ error: error.message }, { status: error.status })
    console.error("[mobile-bootstrap] Unable to load household", { error })
    return Response.json({ error: "Unable to load your household. Please try again." }, { status: 503 })
  }
}
