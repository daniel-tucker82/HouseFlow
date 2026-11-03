import { db } from "@/lib/db"
import { AccountDeletionStatusError, readAccountDeletionStatus } from "@/lib/account-deletion-status"

export const dynamic = "force-dynamic"
const headers = { "Cache-Control": "private, no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer", Vary: "X-Cyntch-Deletion-Request, X-Cyntch-Deletion-Key" }

/** No Clerk/session/account admission dependency: these may already be erased.
 * The recovery key only permits the minimal status response, never a mutation.
 * Keys and IDs belong in headers, not URLs, logs or browser history. */
export async function GET(request: Request) {
  try {
    if (new URL(request.url).search) throw new AccountDeletionStatusError(404)
    const result = await readAccountDeletionStatus(db, { requestId: request.headers.get("X-Cyntch-Deletion-Request") ?? "",
      secret: request.headers.get("X-Cyntch-Deletion-Key") ?? "" })
    return Response.json(result, { headers: { ...headers, ...(result.state === "pending" ? { "Retry-After": "15" } : {}) } })
  } catch (error) {
    if (error instanceof AccountDeletionStatusError) return Response.json({ error: error.message,
      code: error.status === 429 ? "account_deletion_status_limited" : "account_deletion_status_unavailable" },
    { status: error.status, headers: { ...headers, ...(error.status === 429 ? { "Retry-After": "60" } : {}) } })
    console.error("[account-deletion] Status lookup needs retry")
    return Response.json({ error: "Unable to check deletion right now. Please retry.", code: "account_deletion_status_retry" }, { status: 503, headers })
  }
}
