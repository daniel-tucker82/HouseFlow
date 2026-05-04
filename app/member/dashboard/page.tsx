import { redirect } from "next/navigation"
import {
  getCurrentUserOrRedirect,
  getHouseholdMemberViewData,
  getMemberViewLanePreferences,
  getUserHouseholds,
} from "@/lib/data"
import { MemberDashboardClient } from "@/app/member/dashboard/member-dashboard-client"
import { cookies } from "next/headers"
import { constantTimeEqual, getHouseholdKioskSettings, normalizeRole, sha256 } from "@/lib/household-authz"

type MemberDashboardProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function MemberDashboard({ searchParams }: MemberDashboardProps) {
  const user = await getCurrentUserOrRedirect()
  const params = await searchParams
  const memberships = await getUserHouseholds(user.id)

  if (memberships.length === 0) {
    redirect("/")
  }

  const selectedHouseholdId =
    typeof params.household === "string" ? params.household : memberships[0].household.id
  const selectedHousehold =
    memberships.find((m) => m.household.id === selectedHouseholdId)?.household ??
    memberships[0].household
  const selectedMembership =
    memberships.find((m) => m.household.id === selectedHousehold.id) ?? memberships[0]
  const viewerRole = normalizeRole(selectedMembership.role)

  const memberViewData = await getHouseholdMemberViewData(selectedHousehold.id, user.id)
  const validMemberIds = new Set(memberViewData.members.map((member) => member.id))
  const allMemberIds = memberViewData.members.map((member) => member.id)
  let selectedIds = allMemberIds
  let editableMemberIds = [...allMemberIds]
  let kioskModeActive = false

  const cookieStore = await cookies()
  const kioskCookieValue = cookieStore.get("houseflow_kiosk_session")?.value ?? ""
  const [kioskHouseholdId, kioskSessionToken] = kioskCookieValue.split(":", 2)
  const kioskSettings = await getHouseholdKioskSettings(selectedHousehold.id)
  const kioskCookieMatches =
    kioskHouseholdId === selectedHousehold.id &&
    Boolean(kioskSessionToken) &&
    Boolean(kioskSettings.sessionTokenHash) &&
    constantTimeEqual(kioskSettings.sessionTokenHash ?? "", sha256(kioskSessionToken ?? ""))

  if (kioskSettings.kioskActive && kioskCookieMatches) {
    const kioskVisible = kioskSettings.visibleMemberIds.filter((id) => validMemberIds.has(id))
    const kioskEditable = kioskSettings.editableMemberIds.filter((id) => kioskVisible.includes(id))
    if (kioskVisible.length > 0) selectedIds = kioskVisible
    if (kioskEditable.length > 0) editableMemberIds = kioskEditable
    kioskModeActive = true
  } else if (viewerRole === "manager" || viewerRole === "supervisor") {
    const prefs = await getMemberViewLanePreferences(user.id, selectedHousehold.id)
    if (prefs) {
      const visible = prefs.visibleMemberIds.filter((id) => validMemberIds.has(id))
      if (visible.length > 0) {
        selectedIds = visible
      }
      const selectedSet = new Set(selectedIds)
      const editable = prefs.editableMemberIds.filter((id) => selectedSet.has(id))
      editableMemberIds = editable.length > 0 ? editable : [...selectedIds]
    }
  }

  return (
    <MemberDashboardClient
      memberships={memberships}
      selectedHouseholdId={selectedHousehold.id}
      selectedMemberIds={selectedIds}
      editableMemberIds={editableMemberIds}
      viewerRole={viewerRole}
      viewerUserId={user.id}
      leaderId={memberViewData.leaderId}
      members={memberViewData.members}
      tasks={memberViewData.tasks}
      kioskActive={kioskModeActive}
    />
  )
}
