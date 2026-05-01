import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { ensureCurrentUserRecord } from "@/lib/user-sync"

export async function GET(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()

  const { searchParams } = new URL(request.url)
  const householdId = String(searchParams.get("householdId") ?? "").trim() || null
  const limitRaw = Number(searchParams.get("limit") ?? 20)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 20

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

  const notifications = await db.query(
    `select un.id,
            un.event_id,
            un.title,
            un.body,
            un.is_read,
            un.created_at,
            ne.kind,
            ne.household_id,
            ne.metadata->>'url' as url
     from user_notifications un
     join notification_events ne on ne.id = un.event_id
     where un.user_id = $1
       and un.suppressed = false
       and ($2::uuid is null or ne.household_id = $2::uuid)
     order by un.created_at desc
     limit $3`,
    [userId, householdId, limit],
  )
  const unreadCount = await db.query<{ count: string }>(
    `select count(*)::text as count
     from user_notifications un
     join notification_events ne on ne.id = un.event_id
     where un.user_id = $1
       and un.suppressed = false
       and un.is_read = false
       and ($2::uuid is null or ne.household_id = $2::uuid)`,
    [userId, householdId],
  )

  return NextResponse.json({
    notifications: notifications.rows,
    unreadCount: Number(unreadCount.rows[0]?.count ?? "0"),
  })
}
