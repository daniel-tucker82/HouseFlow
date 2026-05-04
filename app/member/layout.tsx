import { cookies } from "next/headers"
import { NativeMemberLayoutChrome } from "@/components/native-member-layout-chrome"
import { getCurrentUserOrRedirect, getUserHouseholds } from "@/lib/data"
import { normalizeRole } from "@/lib/household-authz"

export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUserOrRedirect()
  const memberships = await getUserHouseholds(user.id)
  const canAccessManagement = memberships.some((membership) => normalizeRole(membership.role) !== "member")
  const cookieStore = await cookies()
  const kioskSessionCookie = cookieStore.get("houseflow_kiosk_session")?.value
  return (
    <NativeMemberLayoutChrome lockViewSwitch={Boolean(kioskSessionCookie)} canAccessManagement={canAccessManagement}>
      {children}
    </NativeMemberLayoutChrome>
  )
}
