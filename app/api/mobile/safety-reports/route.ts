import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { AccountAccessError } from "@/lib/account-access"
import { safetyReportsEnabled, submitSafetyReport } from "@/lib/safety-reports"
import { SafetyReportError } from "@/shared/mobile/safety-reports"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "no-store" }
async function readBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) throw new SafetyReportError("Enter a report.")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 12000) { await reader.cancel(); throw new SafetyReportError("This report is too long.", 413) }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally { reader.releaseLock() }
}
async function handle(request: Request) {
  const { userId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401, headers })
  if (!safetyReportsEnabled()) return Response.json({ error: "Reporting is not available yet." }, { status: 404, headers })
  if (request.method === "GET") return Response.json({ accountId: userId, enabled: true }, { headers })
  try {
    const raw = await readBody(request)
    let input: unknown
    try { input = JSON.parse(raw) } catch { throw new SafetyReportError("Enter a valid report.") }
    return Response.json(await submitSafetyReport(db, userId, input), { headers })
  } catch (error) {
    if (error instanceof SafetyReportError || error instanceof AccountAccessError) return Response.json({ error: error.message }, { status: error.status, headers })
    // Never log report text, account identifiers or database error details.
    console.error("[safety-reports] Report could not be saved")
    return Response.json({ error: "Your report could not be confirmed. Your saved copy is kept; try again." }, { status: 503, headers })
  }
}
export function GET(request: Request) { return withNativeKioskRequest(request, handle) }
export function POST(request: Request) { return withNativeKioskRequest(request, handle) }
