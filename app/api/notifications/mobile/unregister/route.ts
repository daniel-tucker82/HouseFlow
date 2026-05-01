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
  if (!token) return NextResponse.json({ error: "token is required" }, { status: 400 })

  await db.query(
    `update mobile_push_tokens
     set is_active = false,
         updated_at = now()
     where user_id = $1
       and token = $2`,
    [userId, token],
  )
  return NextResponse.json({ ok: true })
}
