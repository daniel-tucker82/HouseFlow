import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { readNativeKiosk, saveNativeKiosk } from "@/lib/native-kiosk-store"
import { KioskError } from "@/shared/mobile/kiosk"
import { NotificationSettingsError } from "@/shared/mobile/notification-settings"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { EntitlementError } from "@/lib/entitlements"
import { AccountAccessError } from "@/lib/account-access"

export const dynamic = "force-dynamic"
async function handle(request: Request, write: boolean) {
  const { userId, sessionId } = await auth()
  if (!userId || !sessionId) return Response.json({ error: "Sign in to manage this device." }, { status: 401 })
  if (request.headers.get("X-Task-Save-User") !== userId || request.headers.get("X-Cyntch-Session") !== sessionId) return Response.json({ error: "Your account changed. Sign in again." }, { status: 403 })
  const deviceId = request.headers.get("X-Cyntch-Device")?.toLowerCase() ?? "", secret = request.headers.get("X-Cyntch-Installation") ?? ""
  try {
    await enforceRequestLimit(userId, write ? "write" : "read")
    let result
    if (write) {
      const raw = await request.text()
      if (Buffer.byteLength(raw, "utf8") > 65_536) throw new KioskError("The kiosk settings are too large.")
      let body: unknown
      try { body = JSON.parse(raw) } catch { throw new KioskError("Choose valid kiosk settings.") }
      result = await saveNativeKiosk(db, userId, sessionId, deviceId, secret, body)
    } else result = await readNativeKiosk(db, userId, sessionId, deviceId, secret)
    return Response.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof KioskError || error instanceof NotificationSettingsError || error instanceof EntitlementError || error instanceof AccountAccessError) return Response.json({ error: error.message,
      ...(error instanceof AccountAccessError ? {code:error.code} : {}) }, { status: error.status, headers: { "Cache-Control": "no-store" } })
    console.error("[native-kiosk] Unable to update device lock", { name: error instanceof Error ? error.name : "UnknownError", code: (error as { code?: string })?.code })
    return Response.json({ error: "Kiosk mode could not sync. The device must remain protected until this finishes." }, { status: 503 })
  }
}
export function GET(request: Request) { return handle(request, false) }
export function POST(request: Request) { return handle(request, true) }
