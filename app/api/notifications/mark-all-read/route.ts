import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { ensureCurrentUserRecord } from "@/lib/user-sync"

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()

  const body = await request.json().catch(() => ({}))
  const householdId = String(body?.householdId ?? "").trim() || null
  if (householdId) {
    const membership = await db.query(
      `select 1
       from household_members
       where household_id = $1::uuid
         and user_id = $2
       limit 1`,
      [householdId, userId],
    )
    if ((membership.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
  }

  const result = await db.query(
    `update user_notifications un
     set is_read = true,
         read_at = coalesce(un.read_at, now())
     from notification_events ne
     where un.event_id = ne.id
       and un.user_id = $1
       and un.is_read = false
       and ($2::uuid is null or ne.household_id = $2::uuid)
     returning un.id`,
    [userId, householdId],
  )
  return NextResponse.json({ ok: true, updated: result.rowCount ?? 0 })
}
