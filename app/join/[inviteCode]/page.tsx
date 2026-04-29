import Link from "next/link"
import { acceptInvite } from "@/lib/actions/household"
import { getInviteByCode } from "@/lib/data"

type JoinPageProps = {
  params: Promise<{ inviteCode: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function JoinInvitePage({ params, searchParams }: JoinPageProps) {
  const { inviteCode } = await params
  const query = await searchParams
  const error = typeof query.error === "string" ? query.error : ""
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

      <Link className="underline text-sm" href={`/auth/login?next=/join/${inviteCode}`}>
        Sign in with a different account
      </Link>
    </main>
  )
}
