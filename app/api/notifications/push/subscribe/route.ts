import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { ensureCurrentUserRecord } from "@/lib/user-sync"

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()

  const body = await request.json()
  const endpoint = String(body?.subscription?.endpoint ?? "").trim()
  const p256dh = String(body?.subscription?.keys?.p256dh ?? "").trim()
  const authKey = String(body?.subscription?.keys?.auth ?? "").trim()
  const deviceId = String(body?.deviceId ?? "").trim() || "browser"
  const userAgent = request.headers.get("user-agent")
  if (!endpoint || !p256dh || !authKey) {
    return NextResponse.json({ error: "Invalid subscription payload" }, { status: 400 })
  }

  await db.query(
    `insert into push_subscriptions (user_id, device_id, endpoint, p256dh, auth, user_agent, is_active, last_seen_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, true, now(), now())
     on conflict (endpoint)
     do update set user_id = excluded.user_id,
                   device_id = excluded.device_id,
                   p256dh = excluded.p256dh,
                   auth = excluded.auth,
                   user_agent = excluded.user_agent,
                   is_active = true,
                   last_seen_at = now(),
                   updated_at = now()`,
    [userId, deviceId, endpoint, p256dh, authKey, userAgent],
  )

  return NextResponse.json({ ok: true })
}
