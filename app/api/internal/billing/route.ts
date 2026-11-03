import { timingSafeEqual } from "node:crypto"
import { runNativeBilling } from "@/lib/run-native-billing"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return Response.json({ error: "Cron is not configured" }, { status: 503 })
  const actual = Buffer.from(request.headers.get("authorization") ?? ""), expected = Buffer.from(`Bearer ${secret}`)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const result = await runNativeBilling()
  return Response.json(result, { status: result.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } })
}
