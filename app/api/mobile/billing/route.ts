import { auth } from "@clerk/nextjs/server"
import { after } from "next/server"
import { EntitlementError } from "@/lib/entitlements"
import { BillingPurchaseError } from "@/lib/billing-purchase-attempts"
import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { runNativeBilling } from "@/lib/run-native-billing"
import { beginNativeBillingPurchase, billingUuid, cancelNativeBillingPurchase, parseNativeBillingAction,
  prepareNativeBilling, readNativeBillingStatus, requestNativeBillingVerification } from "@/lib/native-billing-actions"
import type { NativeBillingAction } from "@/shared/mobile/billing"
import { prepareWebBillingCancellation } from "@/lib/native-billing-management"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30
const headers = { "Cache-Control": "no-store" }

async function handle(request: Request, write: boolean) {
  const { userId, sessionId } = await auth()
  if (!userId) return Response.json({ error: "Sign in required." }, { status: 401, headers })
  if (!sessionId || request.headers.get("X-Task-Save-User") !== userId || request.headers.get("X-Cyntch-Session") !== sessionId) {
    return Response.json({ error: "Your sign-in changed. Refresh before managing billing." }, { status: 403, headers })
  }
  const deviceId = request.headers.get("X-Cyntch-Device")?.toLowerCase()
  if (!billingUuid(deviceId)) return Response.json({ error: "A valid device is required." }, { status: 400, headers })
  try {
    let action: NativeBillingAction | undefined
    if (write) {
      const raw = await request.text()
      if (Buffer.byteLength(raw, "utf8") > 4096) throw new EntitlementError("This billing request is too large.", 413)
      let body: unknown
      try { body = JSON.parse(raw) } catch { throw new EntitlementError("Invalid billing request.", 400) }
      action = parseNativeBillingAction(body)
    }
    const householdId = action?.householdId ?? new URL(request.url).searchParams.get("householdId")
    if (!billingUuid(householdId)) throw new EntitlementError("Choose a household.", 400)
    await enforceRequestLimit(userId, action && ["begin","verify","webCancellation"].includes(action.action) ? "billing" : write ? "write" : "read")
    const scope = { accountId: userId, sessionId, deviceId, householdId: householdId.toLowerCase() }
    let result
    if (!action) result = await readNativeBillingStatus(scope)
    else if (action.action === "prepare") result = await prepareNativeBilling(scope, action.store)
    else if (action.action === "begin") result = await beginNativeBillingPurchase(scope, action)
    else if (action.action === "cancel") result = await cancelNativeBillingPurchase(scope, action)
    else if (action.action === "webCancellation") result = await prepareWebBillingCancellation(scope)
    else result = await requestNativeBillingVerification(scope)
    if (action?.action === "verify" || action?.action === "cancel") after(async () => { await runNativeBilling() })
    return Response.json(result, { headers })
  } catch (error) {
    if (error instanceof EntitlementError) return Response.json({ error: error.message,
      ...(error instanceof BillingPurchaseError ? { code: error.code } : {}) }, { status: error.status, headers })
    console.error("[native-billing] Billing action failed", { name: error instanceof Error ? error.name : "UnknownError" })
    return Response.json({ error: "Unable to confirm billing right now. Your purchases can be restored when the connection is available." }, { status: 503, headers })
  }
}
export function GET(request: Request) { return withNativeKioskRequest(request, request => handle(request, false)) }
export function POST(request: Request) { return withNativeKioskRequest(request, request => handle(request, true)) }
