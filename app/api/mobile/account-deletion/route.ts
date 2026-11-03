import { auth } from "@clerk/nextjs/server"
import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { EntitlementError } from "@/lib/entitlements"
import { AccountDeletionError, readAccountDeletionReview } from "@/lib/account-deletion-review"
import { NotificationSettingsError, notificationUuid } from "@/shared/mobile/notification-settings"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control":"no-store" }
async function handle(request: Request) {
  const { userId,sessionId } = await auth()
  if (!userId || !sessionId) return Response.json({error:"Sign in to review account deletion."},{status:401,headers})
  if (request.headers.get("X-Task-Save-User") !== userId || request.headers.get("X-Cyntch-Session") !== sessionId) return Response.json({error:"Your sign-in changed. Reopen account settings."},{status:403,headers})
  const deviceId = request.headers.get("X-Cyntch-Device") ?? ""
  if (!notificationUuid.test(deviceId)) return Response.json({error:"A valid device is required."},{status:400,headers})
  try {
    await enforceRequestLimit(userId,"read")
    return Response.json(await readAccountDeletionReview({accountId:userId,sessionId,deviceId},request.headers.get("X-Cyntch-Installation") ?? ""),{headers})
  } catch (error) {
    if (error instanceof AccountDeletionError || error instanceof NotificationSettingsError || error instanceof EntitlementError) return Response.json({error:error.message,
      ...(error instanceof AccountDeletionError ? {code:error.code} : {})},{status:error.status,headers})
    console.error("[account-deletion] Unable to review account",{name:error instanceof Error ? error.name : "UnknownError"})
    return Response.json({error:"Unable to review account deletion. Please try again."},{status:503,headers})
  }
}
// Mutation is added only with durable deletion processing and confirmation UI.
export function GET(request: Request) { return withNativeKioskRequest(request,handle) }
