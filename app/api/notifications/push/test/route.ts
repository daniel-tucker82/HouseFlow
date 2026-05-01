import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { ensureCurrentUserRecord } from "@/lib/user-sync"
import { dispatchPushForNotificationIds } from "@/lib/push"

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()

  const body = await request.json().catch(() => ({}))
  const householdId = String(body?.householdId ?? "").trim()
  if (!householdId) return NextResponse.json({ error: "householdId is required" }, { status: 400 })

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

  const eventResult = await db.query<{ id: string }>(
    `insert into notification_events (household_id, kind, actor_user_id, metadata)
     values ($1::uuid, 'routine_occurrence_generated'::notification_kind, $2, '{"test": true}'::jsonb)
     returning id`,
    [householdId, userId],
  )
  const eventId = String(eventResult.rows[0]?.id ?? "")
  if (!eventId) return NextResponse.json({ error: "Unable to create test event" }, { status: 500 })
  const notificationResult = await db.query<{ id: string }>(
    `insert into user_notifications (event_id, user_id, title, body)
     values ($1::uuid, $2, $3, $4)
     returning id`,
    [eventId, userId, "Push test", "Cyntch push notifications are working on this device."],
  )
  const notificationId = String(notificationResult.rows[0]?.id ?? "")
  if (notificationId) {
    await dispatchPushForNotificationIds([notificationId])
  }

  return NextResponse.json({ ok: true })
}
