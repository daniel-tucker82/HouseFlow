import Link from "next/link"
import { auth } from "@clerk/nextjs/server"
import { redirect } from "next/navigation"
import { acceptInvite } from "@/lib/actions/household"
import { getInviteByCode } from "@/lib/data"
import { acceptInviteByCode } from "@/lib/actions/household"
import { ensureCurrentUserRecord } from "@/lib/user-sync"

type JoinPageProps = {
  params: Promise<{ inviteCode: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function JoinInvitePage({ params, searchParams }: JoinPageProps) {
  const { inviteCode } = await params
  const query = await searchParams
  const error = typeof query.error === "string" ? query.error : ""
  const autoJoin = query.autoJoin === "1"
  const { userId } = await auth()

  if (userId && autoJoin) {
    await ensureCurrentUserRecord()
    try {
      await acceptInviteByCode(inviteCode, userId)
      redirect("/member/dashboard")
    } catch (joinError) {
      const message = joinError instanceof Error ? joinError.message : "Unable to accept invite."
      redirect(`/join/${inviteCode}?error=${encodeURIComponent(message)}`)
    }
  }

  const invite = await getInviteByCode(inviteCode)

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Join household</h1>
      <p className="text-sm text-muted-foreground">Invite code: {inviteCode}</p>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}

      {!invite ? (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm">
          Invite not found or unavailable.
        </p>
      ) : (
        <form action={acceptInvite} className="flex flex-col gap-3 rounded border p-4">
          <input type="hidden" name="inviteCode" value={inviteCode} />
          <p className="text-sm">
            Join this household now. If you are not signed in, you will be redirected to login.
          </p>
          <button className="rounded bg-black px-3 py-2 text-white" type="submit">
            Accept invite
          </button>
        </form>
      )}

      <Link className="underline text-sm" href={`/auth/login?next=${encodeURIComponent(`/join/${inviteCode}?autoJoin=1`)}`}>
        Sign in with a different account
      </Link>
    </main>
  )
}
