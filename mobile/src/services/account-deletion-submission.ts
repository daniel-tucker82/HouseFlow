import { accountDeletionOrigin, normalizeAccountDeletionSubmission, parseAccountDeletionAcceptance, validAccountDeletionRecovery,
  type AccountDeletionRecovery, type AccountDeletionSubmission, type AccountDeletionAcceptance } from "../../../shared/mobile/account-deletion"
import type { DeletionReverificationHint, DeletionWithdrawalCredentials } from "./account-deletion-withdrawal"
import type { DeletionStatusFetch } from "./account-deletion-status"

export class DeletionSubmissionError extends Error {
  constructor(readonly code: "authentication" | "forbidden" | "kiosk" | "changed" | "withdrawn" | "conflict" | "limited" | "unavailable" | "retry" | "cancelled") {
    super(code === "authentication" ? "Your sign-in changed. Check the saved deletion request before continuing." :
      code === "forbidden" ? "Verify your account and device access before trying again." :
      code === "kiosk" ? "Unlock kiosk mode before deleting an account." :
      code === "changed" ? "Your households or subscriptions changed. Withdraw this attempt before reviewing again." :
      code === "withdrawn" ? "This attempt was withdrawn. Confirm its withdrawal before starting a new review." :
      code === "conflict" ? "A different request may already exist. Keep the recovery information and check its status." :
      code === "limited" ? "Please wait a minute before trying again." :
      code === "unavailable" ? "Account deletion submission is temporarily unavailable. Keep the saved request and check its status." :
      "Deletion was not confirmed. Your saved request must be kept so its status can be checked.")
  }
}

/** Send only the exact result of AccountDeletionDrafts.requestForSubmission.
 * Obtain fresh credentials for EVERY call (including useReverification's retry).
 * No automatic destructive retries, draft editing or local cleanup here. */
export class AccountDeletionSubmissionApi {
  readonly origin: string
  constructor(origin: string, private readonly fetcher: DeletionStatusFetch, private readonly allowDevelopmentHttp = false) {
    this.origin = accountDeletionOrigin(origin,allowDevelopmentHttp)
  }
  async submit(saved: AccountDeletionSubmission & { recovery: AccountDeletionRecovery }, credentials: DeletionWithdrawalCredentials,
    signal?: AbortSignal): Promise<AccountDeletionAcceptance | DeletionReverificationHint> {
    let submission: AccountDeletionSubmission
    try { submission = normalizeAccountDeletionSubmission(saved,this.allowDevelopmentHttp) }
    catch { throw new DeletionSubmissionError("authentication") }
    if (submission.origin !== this.origin || submission.accountId !== credentials.accountId || submission.sessionId !== credentials.sessionId || submission.deviceId !== credentials.deviceId ||
      !validAccountDeletionRecovery(saved.recovery) || saved.recovery.requestId !== submission.intent.operationId ||
      typeof credentials.token !== "string" || !credentials.token.length || typeof credentials.installationSecret !== "string" || !/^[a-f0-9]{64}$/.test(credentials.installationSecret)) {
      throw new DeletionSubmissionError("authentication")
    }
    if (signal?.aborted) throw new DeletionSubmissionError("cancelled")
    const controller = new AbortController(), cancel = () => controller.abort(), timeout = setTimeout(cancel,25_000)
    signal?.addEventListener("abort",cancel)
    const url = `${this.origin}/api/mobile/account-deletion`
    try {
      const response = await this.fetcher(url,{ method:"POST",credentials:"omit",redirect:"error",cache:"no-store",referrerPolicy:"no-referrer",signal:controller.signal,
        headers:{ Accept:"application/json","Content-Type":"application/json",Authorization:`Bearer ${credentials.token}`,"X-Task-Save-User":credentials.accountId,
          "X-Cyntch-Session":credentials.sessionId,"X-Cyntch-Device":credentials.deviceId,"X-Cyntch-Installation":credentials.installationSecret,
          "X-Cyntch-Deletion-Request":saved.recovery.requestId,"X-Cyntch-Deletion-Key":saved.recovery.secret },body:JSON.stringify(submission.intent) })
      if (response.redirected || response.url !== url) throw new DeletionSubmissionError("retry")
      const data = await response.json().catch(() => null)
      if (controller.signal.aborted) throw new DeletionSubmissionError(signal?.aborted ? "cancelled" : "retry")
      if (response.status === 403) {
        const hint = (data as Partial<DeletionReverificationHint> | null)?.clerk_error
        if (hint?.type === "forbidden" && hint.reason === "reverification-error" && hint.metadata?.reverification === "strict") {
          return { clerk_error:{ type:"forbidden",reason:"reverification-error",metadata:{reverification:"strict"} } }
        }
      }
      if (response.status !== 200 && response.status !== 202) {
        const code = (data as {code?:unknown} | null)?.code
        throw new DeletionSubmissionError(response.status === 401 ? "authentication" : response.status === 403 ? "forbidden" : response.status === 423 ? "kiosk" :
          response.status === 429 ? "limited" : response.status === 409 ? code === "account_deletion_review_changed" ? "changed" : code === "account_deletion_withdrawn" ? "withdrawn" : "conflict" :
          response.status === 503 && code === "account_deletion_unavailable" ? "unavailable" : "retry")
      }
      const receipt = parseAccountDeletionAcceptance(data,{ ...credentials,requestId:saved.recovery.requestId })
      if ((receipt.status.state === "pending") !== (response.status === 202)) throw new DeletionSubmissionError("retry")
      return receipt
    } catch (error) {
      if (signal?.aborted) throw new DeletionSubmissionError("cancelled")
      if (error instanceof DeletionSubmissionError) throw error
      throw new DeletionSubmissionError("retry")
    } finally { clearTimeout(timeout);signal?.removeEventListener("abort",cancel) }
  }
}
