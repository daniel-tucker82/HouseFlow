import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { ensureCurrentUserRecord } from "@/lib/user-sync"

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()

  const body = await request.json()
  const endpoint = String(body?.endpoint ?? "").trim()
  if (!endpoint) return NextResponse.json({ error: "endpoint is required" }, { status: 400 })

  await db.query(
    `update push_subscriptions
     set is_active = false,
         updated_at = now()
     where endpoint = $1
       and user_id = $2`,
    [endpoint, userId],
  )

  return NextResponse.json({ ok: true })
}
