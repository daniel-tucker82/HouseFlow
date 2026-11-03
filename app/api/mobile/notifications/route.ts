import { auth } from "@clerk/nextjs/server"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { ensureCurrentUserRecord } from "@/lib/user-sync"
import { EntitlementError } from "@/lib/entitlements"
import { readNativeNotificationSettings, saveNativeNotificationSettings } from "@/lib/native-notification-settings"
import { NotificationSettingsError } from "@/shared/mobile/notification-settings"
import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"

export const dynamic = "force-dynamic"
async function handle(request: Request, write: boolean) {
  const { userId, sessionId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 })
  if (request.headers.get("X-Task-Save-User") !== userId) return Response.json({ error: "Your account changed. Sign in again before saving." }, { status: 403 })
  if (!sessionId || request.headers.get("X-Cyntch-Session") !== sessionId) return Response.json({ error: "Your sign-in session changed. Please try again." }, { status: 403 })
  const deviceId = request.headers.get("X-Cyntch-Device")?.toLowerCase() ?? ""
  const installationSecret = request.headers.get("X-Cyntch-Installation") ?? ""
  try {
    await enforceRequestLimit(userId, write ? "write" : "read")
    let result
    if (write) {
      const raw = await request.text()
      if (Buffer.byteLength(raw, "utf8") > 32_768) throw new NotificationSettingsError("The notification settings are too large.")
      let body: unknown
      try { body = JSON.parse(raw) } catch { throw new NotificationSettingsError("The notification settings are invalid.") }
      await ensureCurrentUserRecord()
      result = await saveNativeNotificationSettings(userId, deviceId, installationSecret, body, sessionId)
    } else result = await readNativeNotificationSettings(userId, deviceId, installationSecret, new URL(request.url).searchParams.get("householdId"))
    return Response.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof NotificationSettingsError || error instanceof EntitlementError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } })
    // Database diagnostics can contain push tokens; log only the error class/code here.
    console.error("[native-notifications] Unable to update notification settings", { name: error instanceof Error ? error.name : "UnknownError", code: (error as { code?: string })?.code })
    return Response.json({ error: "Unable to sync notification settings. Your saved changes can retry." }, { status: 503 })
  }
}
export function GET(request: Request) { return withNativeKioskRequest(request, request => handle(request, false)) }
export function POST(request: Request) { return withNativeKioskRequest(request, request => handle(request, true)) }
