import { auth, reverificationErrorResponse } from "@clerk/nextjs/server"
import { withNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { EntitlementError } from "@/lib/entitlements"
import { AccountDeletionError, parseAccountDeletionIntent, readAccountDeletionReview, validateAccountDeletionIntent } from "@/lib/account-deletion-review"
import { NotificationSettingsError, notificationUuid } from "@/shared/mobile/notification-settings"
import { ACCOUNT_DELETION_RECEIPT_LIFETIME_MS, validAccountDeletionRecovery, type AccountDeletionAcceptance } from "@/shared/mobile/account-deletion"
import { AccountAccessError, accountHash } from "@/lib/account-access"
import { acceptAccountDeletion } from "@/lib/account-deletion-requests"
import { readAccountDeletionBody, verifyAccountDeletionSuccessors } from "@/lib/account-deletion-http"
import { db } from "@/lib/db"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control":"private, no-store", "Referrer-Policy":"no-referrer" }
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
export function GET(request: Request) { return withNativeKioskRequest(request,handle) }

/** Explicit rollout gate stays off until confirmation, local cleanup and the
 * durable worker are integrated. Status and withdrawal remain available if new
 * submissions are disabled later. Acceptance owns its exclusive admission lock;
 * using withNativeKioskRequest here would take a conflicting shared lock. */
export async function POST(request: Request) {
  try {
    const identity = await auth(), { userId,sessionId } = identity
    if (!userId || !sessionId) return Response.json({error:"Sign in to delete your account."},{status:401,headers})
    if (request.headers.get("X-Task-Save-User") !== userId || request.headers.get("X-Cyntch-Session") !== sessionId || !/^Bearer \S+$/.test(request.headers.get("authorization") ?? "")) {
      return Response.json({error:"Your sign-in changed. Reopen account settings."},{status:403,headers})
    }
    if (new URL(request.url).search) throw new AccountDeletionError("Deletion information must not be included in a URL.")
    const scope = { accountId:userId,sessionId,deviceId:request.headers.get("X-Cyntch-Device") ?? "" }
    const recovery = { requestId:request.headers.get("X-Cyntch-Deletion-Request") ?? "",secret:request.headers.get("X-Cyntch-Deletion-Key") ?? "" }
    if (!notificationUuid.test(scope.deviceId) || !validAccountDeletionRecovery(recovery)) throw new AccountDeletionError("Save the deletion recovery information before submitting.")
    if (process.env.ACCOUNT_DELETION_SUBMISSION_ENABLED !== "true") {
      return Response.json({error:"Account deletion submission is temporarily unavailable. Your saved request has been kept.",code:"account_deletion_unavailable"},{status:503,headers})
    }
    if (!identity.has({reverification:"strict"})) {
      const response = reverificationErrorResponse("strict")
      for (const [name,value] of Object.entries(headers)) response.headers.set(name,value)
      return response
    }
    // Normal request admission deliberately rejects deleted accounts. This
    // separate quota permits identical lost-receipt retries after acceptance.
    const allowed = await db.query(`insert into application_rate_limits(bucket_key,window_start,requests) values($1,date_trunc('minute',now()),1)
      on conflict(bucket_key,window_start) do update set requests=application_rate_limits.requests+1 where application_rate_limits.requests<10 returning requests`,[`deletion-submit:${accountHash(userId)}`])
    if (!allowed.rowCount) throw new AccountDeletionError("Please wait a minute before trying again.",429,"account_deletion_limited")
    const intent = parseAccountDeletionIntent(await readAccountDeletionBody(request))
    if (intent.operationId !== recovery.requestId) throw new AccountDeletionError("The confirmed request does not match its saved recovery information.")
    const installation = request.headers.get("X-Cyntch-Installation") ?? ""
    const receipt = await acceptAccountDeletion(db,scope,installation,intent,true,async ids => {
      // Do not turn the provider lookup into an arbitrary account-existence
      // probe. Check the selected household parents first. Acceptance repeats
      // this review under its mutation locks after provider work completes.
      validateAccountDeletionIntent(await readAccountDeletionReview(scope,installation),intent)
      await verifyAccountDeletionSuccessors(ids)
    },identity.sessionClaims?.iss ?? "",recovery.secret)
    const result: AccountDeletionAcceptance = { ...scope,status:{ requestId:receipt.requestId,state:receipt.state,acceptedAt:receipt.acceptedAt,completedAt:receipt.completedAt,
      appleRevocationRequired:receipt.appleRevocationRequired,availableUntil:receipt.completedAt ? new Date(Date.parse(receipt.completedAt)+ACCOUNT_DELETION_RECEIPT_LIFETIME_MS).toISOString() : null } }
    return Response.json(result,{status:receipt.state === "pending" ? 202 : 200,headers})
  } catch (error) {
    if (error instanceof AccountDeletionError || error instanceof AccountAccessError || error instanceof NotificationSettingsError) {
      return Response.json({error:error.message,...("code" in error ? {code:error.code} : {})},{status:error.status,
        headers:{...headers,...(error.status === 429 ? {"Retry-After":"60"} : {})}})
    }
    // Even a lost COMMIT acknowledgement must not be described as cancellation.
    console.error("[account-deletion] Submission needs a status check")
    return Response.json({error:"Unable to confirm deletion. Keep the recovery information and check its status."},{status:503,headers})
  }
}
