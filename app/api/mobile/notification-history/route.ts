import { auth } from "@clerk/nextjs/server"
import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { EntitlementError } from "@/lib/entitlements"
import { NotificationSettingsError, notificationUuid } from "@/shared/mobile/notification-settings"
import { NotificationHistoryError, parseNotificationHistoryAction, readNotificationHistory, updateNotificationHistory } from "@/lib/mobile-notification-history"

export const dynamic = "force-dynamic"
const headers={"Cache-Control":"no-store"}
async function handle(request: Request,write: boolean) {
  const {userId,sessionId}=await auth()
  if (!userId || !sessionId) return Response.json({error:"Sign in to view notifications."},{status:401,headers})
  if (request.headers.get("X-Task-Save-User")!==userId || request.headers.get("X-Cyntch-Session")!==sessionId) return Response.json({error:"Your sign-in changed. Reopen notifications."},{status:403,headers})
  try {
    const params=new URL(request.url).searchParams, deviceId=request.headers.get("X-Cyntch-Device") ?? "", secret=request.headers.get("X-Cyntch-Installation") ?? ""
    let action
    if (write) { const raw=await request.text(); if(Buffer.byteLength(raw)>2048) throw new NotificationHistoryError("This notification request is too large.",413); try {action=parseNotificationHistoryAction(JSON.parse(raw))}catch(error){if(error instanceof NotificationHistoryError)throw error;throw new NotificationHistoryError("Invalid notification request.")} }
    const householdId=action?.householdId ?? params.get("householdId") ?? ""
    if (!notificationUuid.test(deviceId) || !notificationUuid.test(householdId)) throw new NotificationHistoryError("Choose a valid household and device.")
    await enforceRequestLimit(userId,write?"write":"read")
    const scope={accountId:userId,sessionId,deviceId,householdId}
    return Response.json(action?await updateNotificationHistory(scope,secret,action):await readNotificationHistory(scope,secret,params),{headers})
  } catch(error) {
    if (error instanceof NotificationHistoryError || error instanceof NotificationSettingsError || error instanceof EntitlementError) return Response.json({error:error.message},{status:error.status,headers})
    console.error("[notification-history] Request failed",{name:error instanceof Error?error.name:"UnknownError"})
    return Response.json({error:"Unable to load notification history. Please try again."},{status:503,headers})
  }
}
export function GET(request:Request){return withNativeKioskRequest(request,request=>handle(request,false))}
export function POST(request:Request){return withNativeKioskRequest(request,request=>handle(request,true))}
