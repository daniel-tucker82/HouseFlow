import { timingSafeEqual } from "node:crypto"
import { runNativeNotifications } from "@/lib/run-native-notifications"

export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return Response.json({ error: "Cron is not configured" }, { status: 503 })
  const actual = Buffer.from(request.headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${secret}`)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: "Unauthorized" }, { status: 401 })
  try { return Response.json({ ok: true, ...await runNativeNotifications() }, { headers: { "Cache-Control": "no-store" } }) }
  catch { return Response.json({ ok: false, error: "Notification processing needs retry" }, { status: 503, headers: { "Cache-Control": "no-store" } }) }
}
