import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { ensureCurrentUserRecord } from "@/lib/user-sync"
import { AccountAccessError } from "@/lib/account-access"
import { acceptTerms, termsStatus, termsAcceptanceRequired, TermsConsentError } from "@/lib/terms-consent"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "no-store" }
async function readAcceptance(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new TermsConsentError("Use a JSON terms request.", 415)
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []
  if (!reader) throw new TermsConsentError("Choose to agree to the current terms.", 400)
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1024) { await reader.cancel(); throw new TermsConsentError("Invalid terms acceptance.", 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }
  catch { throw new TermsConsentError("Invalid terms acceptance.", 400) }
}
async function handle(request: Request) {
  const { userId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401, headers })
  try {
    if (request.method === "GET") return Response.json(await termsStatus(db, userId), { headers })
    if (!termsAcceptanceRequired()) throw new TermsConsentError("Terms acceptance is not enabled on this service.", 404)
    const input = await readAcceptance(request)
    await ensureCurrentUserRecord()
    return Response.json(await acceptTerms(db, userId, input), { headers })
  } catch (error) {
    if (error instanceof TermsConsentError || error instanceof AccountAccessError) return Response.json({ error: error.message }, { status: error.status, headers })
    console.error("[terms] Unable to confirm terms acceptance")
    return Response.json({ error: "Unable to confirm your agreement. Please try again." }, { status: 503, headers })
  }
}
export function GET(request: Request) { return withNativeKioskRequest(request, handle) }
export function POST(request: Request) { return withNativeKioskRequest(request, handle) }
