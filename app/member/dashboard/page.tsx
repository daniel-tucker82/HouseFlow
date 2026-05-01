import { redirect } from "next/navigation"
import { getCurrentUserOrRedirect, getHouseholdMemberViewData, getUserHouseholds } from "@/lib/data"
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
  const rawSelectedMembers =
    typeof params.members === "string"
      ? params.members
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : memberViewData.members.map((member) => member.id)
  const validMemberIds = new Set(memberViewData.members.map((member) => member.id))
  const selectedMemberIds = rawSelectedMembers.filter((id) => validMemberIds.has(id))
  const normalizedSelectedMemberIds =
    selectedMemberIds.length > 0 ? selectedMemberIds : memberViewData.members.map((member) => member.id)
  const selectedMemberIdSet = new Set(normalizedSelectedMemberIds)
  const rawEditableMembers =
    typeof params.editableMembers === "string"
      ? params.editableMembers
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : normalizedSelectedMemberIds
  const normalizedEditableMemberIds = rawEditableMembers.filter((id) => selectedMemberIdSet.has(id))
  let editableMemberIds =
    normalizedEditableMemberIds.length > 0 ? normalizedEditableMemberIds : normalizedSelectedMemberIds
  let selectedIds = normalizedSelectedMemberIds
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
