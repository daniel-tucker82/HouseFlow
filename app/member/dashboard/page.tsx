import { redirect } from "next/navigation"
import { getCurrentUserOrRedirect, getHouseholdMemberViewData, getUserHouseholds } from "@/lib/data"
import { MemberDashboardClient } from "@/app/member/dashboard/member-dashboard-client"

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

  const memberViewData = await getHouseholdMemberViewData(selectedHousehold.id)
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

  return (
    <MemberDashboardClient
      memberships={memberships}
      selectedHouseholdId={selectedHousehold.id}
      selectedMemberIds={normalizedSelectedMemberIds}
      leaderId={memberViewData.leaderId}
      members={memberViewData.members}
      tasks={memberViewData.tasks}
    />
  )
}
