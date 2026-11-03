import { accountDeletionOrigin, parseAccountDeletionWithdrawal, validAccountDeletionRecovery, type AccountDeletionRecovery, type AccountDeletionScope, type AccountDeletionWithdrawalResult } from "../../../shared/mobile/account-deletion"
import type { DeletionStatusFetch } from "./account-deletion-status"
import { notificationSessionId, notificationUuid } from "../../../shared/mobile/notification-settings"

/** Return Clerk's exact hint to useReverification; never treat it as a receipt. */
export interface DeletionReverificationHint { clerk_error: { type: "forbidden"; reason: "reverification-error"; metadata: { reverification: "strict" } } }
export type DeletionWithdrawalCredentials = AccountDeletionScope & { token: string; installationSecret: string }
export class DeletionWithdrawalError extends Error {
  constructor(readonly code: "authentication" | "forbidden" | "kiosk" | "conflict" | "limited" | "retry" | "cancelled") {
    super(code === "authentication" ? "Sign in again as the same account to withdraw this attempt." :
      code === "forbidden" ? "Verify your account and device access before trying again." :
      code === "kiosk" ? "Unlock kiosk mode before withdrawing this attempt." :
      code === "limited" ? "Please wait a minute before trying again." :
      code === "conflict" ? "This attempt may already have an outcome. Keep its recovery information and check its status." :
      "Withdrawal was not confirmed. Keep the recovery information and retry.")
  }
}
export class AccountDeletionWithdrawalApi {
  readonly origin: string
  constructor(origin: string, private readonly fetcher: DeletionStatusFetch, allowDevelopmentHttp = false) {
    this.origin = accountDeletionOrigin(origin,allowDevelopmentHttp)
  }
  async withdraw(recovery: AccountDeletionRecovery & { origin: string; accountId: string }, credentials: DeletionWithdrawalCredentials,
    signal?: AbortSignal): Promise<AccountDeletionWithdrawalResult | DeletionReverificationHint> {
    if (!validAccountDeletionRecovery(recovery) || recovery.origin !== this.origin || recovery.accountId !== credentials.accountId ||
      !/^user_[A-Za-z0-9_-]{1,200}$/.test(credentials.accountId) || !notificationSessionId.test(credentials.sessionId) || !notificationUuid.test(credentials.deviceId) ||
      typeof credentials.token !== "string" || !credentials.token.length || typeof credentials.installationSecret !== "string" || !/^[a-f0-9]{64}$/.test(credentials.installationSecret)) throw new DeletionWithdrawalError("authentication")
    if (signal?.aborted) throw new DeletionWithdrawalError("cancelled")
    const controller = new AbortController(), cancel = () => controller.abort(), timeout = setTimeout(cancel,25_000)
    signal?.addEventListener("abort",cancel)
    const url = `${this.origin}/api/mobile/account-deletion/withdraw`
    try {
      const response = await this.fetcher(url,{ method: "POST",credentials: "omit",redirect: "error",cache: "no-store",referrerPolicy: "no-referrer",signal: controller.signal,
        headers: { Accept: "application/json",Authorization: `Bearer ${credentials.token}`,"X-Task-Save-User": credentials.accountId,"X-Cyntch-Session": credentials.sessionId,
          "X-Cyntch-Device": credentials.deviceId,"X-Cyntch-Installation": credentials.installationSecret,"X-Cyntch-Deletion-Request": recovery.requestId,"X-Cyntch-Deletion-Key": recovery.secret } })
      if (response.redirected || response.url !== url) throw new DeletionWithdrawalError("retry")
      const data = await response.json().catch(() => null)
      if (controller.signal.aborted) throw new DeletionWithdrawalError(signal?.aborted ? "cancelled" : "retry")
      if (response.status === 403) {
        const hint = (data as Partial<DeletionReverificationHint> | null)?.clerk_error
        if (hint?.type === "forbidden" && hint.reason === "reverification-error" && hint.metadata?.reverification === "strict") {
          return { clerk_error: { type: "forbidden",reason: "reverification-error",metadata: { reverification: "strict" } } }
        }
      }
      if (response.status !== 200) throw new DeletionWithdrawalError(response.status === 401 ? "authentication" : response.status === 403 ? "forbidden" :
        response.status === 409 ? "conflict" : response.status === 423 ? "kiosk" : response.status === 429 ? "limited" : "retry")
      return parseAccountDeletionWithdrawal(data,{ ...credentials,requestId: recovery.requestId })
    } catch (error) {
      if (signal?.aborted) throw new DeletionWithdrawalError("cancelled")
      if (error instanceof DeletionWithdrawalError) throw error
      throw new DeletionWithdrawalError("retry")
    } finally { clearTimeout(timeout);signal?.removeEventListener("abort",cancel) }
  }
}
