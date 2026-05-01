import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { ensureCurrentUserRecord } from "@/lib/user-sync"

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()

  const body = await request.json()
  const notificationId = String(body?.notificationId ?? "").trim()
  if (!notificationId) {
    return NextResponse.json({ error: "notificationId is required" }, { status: 400 })
  }

  const result = await db.query(
    `delete from user_notifications
     where id = $1::uuid
       and user_id = $2
     returning id`,
    [notificationId, userId],
  )
  if ((result.rowCount ?? 0) === 0) {
    return NextResponse.json({ error: "Notification not found" }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
