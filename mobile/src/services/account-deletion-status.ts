import { accountDeletionOrigin, parseAccountDeletionStatus, validAccountDeletionRecovery,
  type AccountDeletionRecovery, type AccountDeletionStatus } from "../../../shared/mobile/account-deletion"

export type DeletionStatusFetch = (url: string, options: RequestInit) => Promise<{
  status: number; url: string; redirected: boolean
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}>
export class DeletionStatusError extends Error {
  constructor(readonly code: "unavailable" | "limited" | "retry" | "cancelled", readonly retryAfterMs = 15_000) {
    super(code === "unavailable" ? "The saved request could not be found. This does not confirm whether deletion was accepted. Keep the recovery information and try again." :
      code === "limited" ? "Please wait a minute before checking deletion again." :
      code === "cancelled" ? "The status check was interrupted. Your recovery information is still saved." :
      "Unable to check deletion right now. Your recovery information is still saved. Please retry.")
  }
}

/** A separate transport: deleted Clerk sessions must never be needed to check
 * status. Use expo/fetch on native to enforce cookie omission and no redirects.
 * No connectivity polling or automatic deletion submission happens here. */
export class AccountDeletionStatusApi {
  readonly origin: string
  constructor(origin: string, private readonly fetcher: DeletionStatusFetch, allowDevelopmentHttp = false) {
    this.origin = accountDeletionOrigin(origin, allowDevelopmentHttp)
  }
  async read(recovery: AccountDeletionRecovery & { origin: string }, signal?: AbortSignal): Promise<AccountDeletionStatus> {
    if (!validAccountDeletionRecovery(recovery) || recovery.origin !== this.origin) throw new DeletionStatusError("unavailable")
    if (signal?.aborted) throw new DeletionStatusError("cancelled")
    const controller = new AbortController(), cancel = () => controller.abort()
    signal?.addEventListener("abort", cancel)
    const timeout = setTimeout(cancel, 25_000)
    const url = `${this.origin}/api/mobile/account-deletion/status`
    try {
      const response = await this.fetcher(url, { method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
        referrerPolicy: "no-referrer", signal: controller.signal, headers: { Accept: "application/json",
          "X-Cyntch-Deletion-Request": recovery.requestId, "X-Cyntch-Deletion-Key": recovery.secret } })
      if (response.redirected || response.url !== url) throw new DeletionStatusError("retry")
      if (response.status === 404) throw new DeletionStatusError("unavailable")
      if (response.status === 429) {
        const delay = Number(response.headers.get("retry-after"))
        throw new DeletionStatusError("limited", Number.isInteger(delay) && delay >= 1 && delay <= 3600 ? delay * 1000 : 60_000)
      }
      if (response.status !== 200) throw new DeletionStatusError("retry")
      const status = parseAccountDeletionStatus(await response.json(), recovery.requestId)
      if (controller.signal.aborted) throw new DeletionStatusError("retry")
      return status
    } catch (error) {
      if (signal?.aborted) throw new DeletionStatusError("cancelled")
      if (error instanceof DeletionStatusError) throw error
      // Native networking exceptions can contain URLs or request headers. Do
      // not surface or log them in the signed-out recovery screen.
      throw new DeletionStatusError("retry")
    } finally { clearTimeout(timeout); signal?.removeEventListener("abort", cancel) }
  }
}
