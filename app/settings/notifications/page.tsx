import { redirect } from "next/navigation"
import { db } from "@/lib/db"
import { getCurrentUserOrRedirect, getUserHouseholds } from "@/lib/data"
import { NotificationSettingsClient } from "@/app/settings/notifications/notification-settings-client"

type NotificationSettingsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function NotificationSettingsPage({ searchParams }: NotificationSettingsPageProps) {
  const user = await getCurrentUserOrRedirect()
  const memberships = await getUserHouseholds(user.id)
  if (memberships.length === 0) redirect("/")

  const params = await searchParams
  const selectedHouseholdId =
    typeof params.household === "string" ? params.household : memberships[0].household.id
  const selectedHousehold =
    memberships.find((membership) => membership.household.id === selectedHouseholdId)?.household ??
    memberships[0].household

  const membersResult = await db.query<{ id: string; name: string }>(
    `select hm.user_id as id,
            coalesce(u.full_name, u.email, hm.user_id) as name
     from household_members hm
     left join users u on u.id = hm.user_id
     where hm.household_id = $1::uuid
     order by name asc`,
    [selectedHousehold.id],
  )

  return (
    <NotificationSettingsClient
      memberships={memberships.map((membership) => ({
        role: membership.role,
        household: { id: membership.household.id, name: membership.household.name },
      }))}
      members={membersResult.rows}
      initialHouseholdId={selectedHousehold.id}
    />
  )
}
