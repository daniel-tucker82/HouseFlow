import { revokeNativeNotificationSession } from "@/lib/native-notification-settings"
import { NotificationSettingsError, notificationUuid } from "@/shared/mobile/notification-settings"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { EntitlementError } from "@/lib/entitlements"

export async function POST(request: Request) {
  const deviceId = request.headers.get("X-Cyntch-Device") ?? "", secret = request.headers.get("X-Cyntch-Installation") ?? ""
  try {
    if (!notificationUuid.test(deviceId) || !/^[a-f0-9]{64}$/.test(secret)) throw new NotificationSettingsError("Invalid installation.", 403)
    await enforceRequestLimit(`native-revoke:${deviceId}`, "write")
    const raw = await request.text()
    if (Buffer.byteLength(raw, "utf8") > 1024) throw new NotificationSettingsError("Invalid revocation request.")
    let body
    try { body = JSON.parse(raw) } catch { throw new NotificationSettingsError("Invalid revocation request.") }
    if (!body || typeof body.accountId !== "string" || typeof body.sessionId !== "string") throw new NotificationSettingsError("Invalid notification session.")
    const result = await revokeNativeNotificationSession(deviceId, secret, body.accountId, body.sessionId)
    return Response.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof NotificationSettingsError || error instanceof EntitlementError) return Response.json({ error: error.message }, { status: error.status })
    console.error("[native-notifications] Session revocation needs retry")
    return Response.json({ error: "Notification sign-out needs retry." }, { status: 503 })
  }
}
