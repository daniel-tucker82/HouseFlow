import Link from "next/link"
import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { isPostgresConfigured } from "@/lib/config"
import { getCurrentUserOrRedirect, getUserHouseholds } from "@/lib/data"
import { resolveActiveKioskHouseholdFromCookie } from "@/lib/household-authz"
import { roleToDashboard } from "@/lib/routing"

export default async function HomePage() {
  if (!isPostgresConfigured()) {
    return (
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6">
        <h1 className="text-3xl font-semibold">HouseFlow setup required</h1>
        <p className="text-muted-foreground">
          PostgreSQL is not configured yet, so app data features are paused.
        </p>
        <div className="rounded border p-4 text-sm">
          <p className="font-medium">Using Clerk + Railway Postgres mode.</p>
          <p className="text-muted-foreground">
            Set `POSTGRES_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and `CLERK_SECRET_KEY` in
            your environment.
          </p>
        </div>
        <Link className="underline text-sm" href="/auth/login">
          Open sign in
        </Link>
      </main>
    )
  }

  const user = await getCurrentUserOrRedirect()

  let memberships: Awaited<ReturnType<typeof getUserHouseholds>> = []
  try {
    memberships = await getUserHouseholds(user.id)
  } catch (error) {
    console.error("HomePage failed to load household memberships.", error)
    return (
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6">
        <h1 className="text-3xl font-semibold">Database connection issue</h1>
        <p className="text-muted-foreground">
          Clerk is running, but PostgreSQL is unreachable from this app.
        </p>
        <div className="rounded border p-4 text-sm">
          <p className="font-medium">Check your local PostgreSQL connection</p>
          <p className="text-muted-foreground">
            HouseFlow is configured for local dev. Make sure `POSTGRES_URL` points to a running
            database (for Docker default: `postgres://houseflow:houseflow@localhost:6543/houseflow`).
          </p>
        </div>
        <Link className="underline text-sm" href="/auth/login">
          Return to sign in
        </Link>
      </main>
    )
  }

  if (memberships.length > 0) {
    const cookieStore = await cookies()
    const kioskCookieValue = cookieStore.get("houseflow_kiosk_session")?.value ?? null
    const activeKioskHouseholdId = await resolveActiveKioskHouseholdFromCookie(kioskCookieValue)
    if (activeKioskHouseholdId) {
      const matchingMembership = memberships.find((membership) => membership.household.id === activeKioskHouseholdId)
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
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6">
      <h1 className="text-3xl font-semibold">Welcome to HouseFlow</h1>
      <p className="text-muted-foreground">
        You’re signed in, but you’re not part of a household yet.
      </p>
      <div className="flex gap-3">
        <Link className="underline" href="/leader/dashboard">
          Create a household
        </Link>
        <Link className="underline" href="/auth/login">
          Switch account
        </Link>
      </div>
    </main>
  )
}
