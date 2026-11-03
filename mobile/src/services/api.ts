import type { BoardSnapshot, CompletionChange, CompletionResult, HouseholdSummary } from "../../../shared/mobile/contracts"
import { TransportError, type SyncTransport } from "../storage/sync-engine"

export interface BootstrapResult { accountId: string; households: HouseholdSummary[]; board: BoardSnapshot | null }

/** All requests are bound to the account which opened this runtime. */
export class MobileApi implements SyncTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly accountId: string,
    private readonly deviceId: string,
    private readonly token: () => Promise<string | null>,
  ) {
    const url = new URL(baseUrl)
    if (url.protocol !== "https:" && !__DEV__) throw new Error("Cyntch requires a secure connection")
  }

  async request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const token = await this.token()
    if (!token) throw new TransportError("Sign in again to sync your saved changes.", 401)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25_000)
    try {
      const response = await fetch(new URL(path, this.baseUrl).toString(), {
        method: body ? "POST" : "GET", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          "X-Task-Save-User": this.accountId, "X-Cyntch-Device": this.deviceId },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new TransportError(data?.error ?? "Cyntch could not sync right now. Your saved changes will retry.", response.status)
      if (!data || typeof data !== "object") throw new Error("Cyntch returned an unexpected response")
      return data as T
    } finally { clearTimeout(timeout) }
  }

  async bootstrap(householdId?: string): Promise<BootstrapResult> {
    const data = await this.request<BootstrapResult>(`/api/mobile/bootstrap${householdId ? `?householdId=${encodeURIComponent(householdId)}` : ""}`)
    if (data.accountId !== this.accountId) throw new Error("Your account changed. Please sign in again.")
    return data
  }

  async serverTime() { return (await this.request<{ serverTimeMs: number }>("/api/mobile/time")).serverTimeMs }

  send(change: CompletionChange) {
    if (change.accountId !== this.accountId || change.correctedTimeMs === null) throw new Error("This change is not ready to sync")
    return this.request<CompletionResult>("/api/mobile/completions", {
      action: "setOccurrenceTaskCompleted", householdId: change.householdId, occurrenceId: change.occurrenceId,
      taskId: change.taskId, actorMemberId: change.memberId, completed: change.completed,
      clientOperation: { id: change.id, deviceId: change.deviceId, sequence: change.sequence, correctedTimeMs: change.correctedTimeMs },
    })
  }
}
