import type { CompletionChange, CompletionResult } from "../../../shared/mobile/contracts"
import { estimateClockOffset } from "../../../shared/mobile/sync-policy"
import type { LocalStore } from "./local-store"

export interface SyncTransport {
  serverTime(): Promise<number>
  send(change: CompletionChange): Promise<CompletionResult>
}

export class TransportError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) { super(message) }
}

export class SyncEngine {
  private running: Promise<void> | null = null
  private cancelled = false

  constructor(
    private readonly store: LocalStore,
    private readonly accountId: string,
    private readonly transport: SyncTransport,
    private readonly onChange: (acknowledged?: boolean) => void,
    private readonly now: () => number = Date.now,
  ) {}

  stop() { this.cancelled = true }

  flush(): Promise<void> {
    if (this.cancelled) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.run().finally(() => { this.running = null })
    return this.running
  }

  private async run() {
    const all = await this.store.pending(this.accountId)
    const batch = all.filter(change => change.state === "pending" && change.nextAttemptMs <= this.now())
    if (this.cancelled || batch.length === 0) return // No idle clock or connectivity requests.
    const uncorrected = batch.filter(change => change.correctedTimeMs === null)
    if (uncorrected.length > 0) {
      try {
        const sentAt = this.now()
        const serverTime = await this.transport.serverTime()
        if (this.cancelled) return
        const { offsetMs } = estimateClockOffset(serverTime, sentAt, this.now())
        await this.store.correctBatch(this.accountId, uncorrected.map(change => change.id), offsetMs)
      } catch (error) {
        if (this.cancelled) return
        for (const change of batch) await this.store.defer(this.accountId, change.id,
          error instanceof Error ? error.message : "Waiting for a connection", this.now())
        this.onChange()
        return
      }
    }
    const batchIds = new Set(batch.map(change => change.id))
    const ready = (await this.store.pending(this.accountId)).filter(change => batchIds.has(change.id))
    for (const change of ready) {
      if (this.cancelled) return
      // Do not overtake an earlier operation which is still in backoff/rejected for this task.
      const earlier = all.some(previous => previous.sequence < change.sequence &&
        previous.householdId === change.householdId && previous.occurrenceId === change.occurrenceId &&
        previous.taskId === change.taskId && !batchIds.has(previous.id))
      if (earlier) continue
      try {
        const response = await this.transport.send(change)
        if (this.cancelled) return // The next sign-in can safely retry the same operation ID.
        if (response.operationId !== change.id) throw new Error("Unexpected synchronisation response")
        await this.store.acknowledge(this.accountId, response)
        this.onChange(response.outcome !== "rejected")
        if (response.outcome === "rejected") break
      } catch (error) {
        if (this.cancelled) return
        if (error instanceof TransportError && [400, 403, 404, 409, 410, 422].includes(error.status)) {
          await this.store.acknowledge(this.accountId, { operationId: change.id, outcome: "rejected",
            error: error.message, occurrenceTaskStatuses: [] })
        } else {
          await this.store.defer(this.accountId, change.id, error instanceof Error ? error.message : "Waiting for a connection", this.now())
        }
        this.onChange()
        break // Preserve sequence and back off. Never busy-loop on an unavailable service.
      }
    }
  }
}
