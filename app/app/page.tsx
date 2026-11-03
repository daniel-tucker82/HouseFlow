import Link from "next/link"
import { Brand } from "@/components/brand"
import { House } from "lucide-react"
import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { NoHouseholdActions } from "@/components/no-household-actions"
import { isPostgresConfigured } from "@/lib/config"
import { getCurrentUserOrRedirect, getUserHouseholds } from "@/lib/data"
import { resolveActiveKioskHouseholdFromCookie } from "@/lib/household-authz"
import { roleToDashboard } from "@/lib/routing"

function UnavailableMessage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-6 px-6 py-12">
      <Link href="/" aria-label="Cyntch home">
        <Brand />
      </Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">We can’t open your household right now.</h1>
      <p className="text-sm leading-7 text-muted-foreground">
        There’s a connection problem. Please try again in a moment.
      </p>
      <div className="flex items-center gap-5">
        <a href="/app" className="marketing-button">
          Try again
        </a>
        <Link href="/" className="text-sm text-muted-foreground underline">
          Back to homepage
        </Link>
      </div>
    </main>
  )
}

export default async function AppEntryPage() {
  if (!isPostgresConfigured()) {
    console.error("Cyntch: POSTGRES_URL is not configured.")
    return <UnavailableMessage />
  }
  const user = await getCurrentUserOrRedirect()
  let memberships: Awaited<ReturnType<typeof getUserHouseholds>> = []
  try {
    memberships = await getUserHouseholds(user.id)
  } catch (error) {
    console.error("App entry failed to load household memberships.", error)
    return <UnavailableMessage />
  }

  if (memberships.length > 0) {
    const cookieStore = await cookies()
    const kioskCookieValue = cookieStore.get("houseflow_kiosk_session")?.value ?? null
    const activeKioskHouseholdId = await resolveActiveKioskHouseholdFromCookie(kioskCookieValue)
    if (activeKioskHouseholdId) {
      const matchingMembership = memberships.find(
        (membership) => membership.household.id === activeKioskHouseholdId,
      )
      if (matchingMembership) {
        redirect(`/member/dashboard?household=${activeKioskHouseholdId}`)
      }
    }

    const managementMembership = memberships.find(
      (membership) =>
        membership.role === "manager" || membership.role === "supervisor" || membership.role === "leader",
    )
    redirect(roleToDashboard((managementMembership ?? memberships[0]).role))
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-1 flex-col justify-center gap-6 px-6 py-16">
      <Link href="/" aria-label="Cyntch home">
        <Brand />
      </Link>
      <span className="mt-6 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <House className="size-7" />
      </span>
      <h1 className="text-4xl font-semibold tracking-tight">A calmer household starts here.</h1>
      <p className="text-muted-foreground">
        Welcome to Cyntch. Create a household to bring your people, tasks and routines together. Joining an
        existing household? Open the invitation link shared with you.
      </p>
      <NoHouseholdActions />
    </main>
  )
}
