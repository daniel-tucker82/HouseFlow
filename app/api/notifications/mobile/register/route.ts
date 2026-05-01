import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { ensureCurrentUserRecord } from "@/lib/user-sync"

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()

  const body = await request.json().catch(() => ({}))
  const token = String(body?.token ?? "").trim()
  const platform = String(body?.platform ?? "").trim().toLowerCase()
  const deviceId = String(body?.deviceId ?? "").trim() || null
  const deviceName = String(body?.deviceName ?? "").trim() || null
  const appVersion = String(body?.appVersion ?? "").trim() || null

  if (!token) return NextResponse.json({ error: "token is required" }, { status: 400 })
  if (platform !== "ios" && platform !== "android") {
    return NextResponse.json({ error: "platform must be ios or android" }, { status: 400 })
  }

  await db.query(
    `insert into mobile_push_tokens (
       user_id,
       token,
       platform,
       device_id,
       device_name,
       app_version,
       is_active,
       last_seen_at,
       updated_at
     )
     values ($1, $2, $3, $4, $5, $6, true, now(), now())
     on conflict (token)
     do update set user_id = excluded.user_id,
                   platform = excluded.platform,
                   device_id = excluded.device_id,
                   device_name = excluded.device_name,
                   app_version = excluded.app_version,
                   is_active = true,
                   last_seen_at = now(),
                   updated_at = now()`,
    [userId, token, platform, deviceId, deviceName, appVersion],
  )

  return NextResponse.json({ ok: true })
}
