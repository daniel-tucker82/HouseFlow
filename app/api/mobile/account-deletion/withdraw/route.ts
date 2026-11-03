import { auth, reverificationErrorResponse } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { withdrawAccountDeletion } from "@/lib/account-deletion-withdrawal"
import { AccountDeletionError } from "@/lib/account-deletion-review"
import { AccountAccessError } from "@/lib/account-access"
import { NotificationSettingsError } from "@/shared/mobile/notification-settings"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" }

/** Only withdraws an unaccepted attempt. Unlike status lookup this endpoint
 * ALWAYS needs authenticated, strictly reverified identity and device access. */
export async function POST(request: Request) {
  try {
    const identity = await auth(), { userId, sessionId } = identity
    if (!userId || !sessionId) return Response.json({ error: "Sign in to withdraw this attempt." }, { status: 401, headers })
    if (request.headers.get("X-Task-Save-User") !== userId || request.headers.get("X-Cyntch-Session") !== sessionId) {
      return Response.json({ error: "Your sign-in changed. Reopen account settings." }, { status: 403, headers })
    }
    if (new URL(request.url).search) throw new AccountDeletionError("Recovery information must not be included in a URL.")
    if (!identity.has({ reverification: "strict" })) {
      const response = reverificationErrorResponse("strict")
      for (const [name, value] of Object.entries(headers)) response.headers.set(name,value)
      return response
    }
    const result = await withdrawAccountDeletion(db,{ accountId: userId, sessionId, deviceId: request.headers.get("X-Cyntch-Device") ?? "" },
      request.headers.get("X-Cyntch-Installation") ?? "",{ requestId: request.headers.get("X-Cyntch-Deletion-Request") ?? "", secret: request.headers.get("X-Cyntch-Deletion-Key") ?? "" },
      true,identity.sessionClaims?.iss ?? "")
    return Response.json(result,{headers})
  } catch (error) {
    if (error instanceof AccountDeletionError || error instanceof AccountAccessError || error instanceof NotificationSettingsError) {
      return Response.json({ error: error.message, ...("code" in error ? { code: error.code } : {}) },{ status: error.status,
        headers: { ...headers, ...(error.status === 429 ? { "Retry-After": "60" } : {}) } })
    }
    console.error("[account-deletion] Withdrawal needs retry")
    return Response.json({ error: "Unable to withdraw this attempt right now. Keep its recovery information and retry." },{ status: 503, headers })
  }
}
