import { Suspense } from "react"
import { AppHeader } from "@/components/app-header"
import { cookies } from "next/headers"
import { getCurrentUserOrRedirect, getUserHouseholds } from "@/lib/data"
import { normalizeRole } from "@/lib/household-authz"

export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUserOrRedirect()
  const memberships = await getUserHouseholds(user.id)
  const canAccessManagement = memberships.some((membership) => normalizeRole(membership.role) !== "member")
  const cookieStore = await cookies()
  const kioskSessionCookie = cookieStore.get("houseflow_kiosk_session")?.value
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <Suspense fallback={<div className="h-[var(--app-header-height)] shrink-0 border-b border-border/70 bg-card/90" />}>
        <AppHeader lockViewSwitch={Boolean(kioskSessionCookie)} canAccessManagement={canAccessManagement} />
      </Suspense>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </div>
  )
}
