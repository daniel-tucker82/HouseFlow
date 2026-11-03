import type { BoardSnapshot, BoardTask, CompletionChange, HouseholdSummary } from "../../../shared/mobile/contracts"
import type { LocalStore } from "../storage/local-store"
import { SyncEngine, TransportError, type SyncTransport } from "../storage/sync-engine"
import type { BootstrapResult } from "./api"
import type { RunSnapshot } from "../../../shared/mobile/runs"

interface BoardApi extends SyncTransport { bootstrap(householdId?: string): Promise<BootstrapResult>; run?(householdId: string, occurrenceId: string): Promise<RunSnapshot> }
export interface BoardState {
  board: BoardSnapshot | null; households: HouseholdSummary[]; pending: CompletionChange[];
  loading: boolean; refreshing: boolean; online: boolean; error: string | null;
}

/** Only the first outstanding edit for each task can be sent. Rejections need user action. */
export function nextSyncDelay(changes: CompletionChange[], now: number): number | null {
  const first = new Map<string, CompletionChange>()
  for (const change of changes) {
    const key = `${change.householdId}:${change.occurrenceId}:${change.taskId}`
    if (!first.has(key)) first.set(key, change)
  }
  const eligible = [...first.values()].filter(change => change.state === "pending")
  return eligible.length ? Math.max(0, Math.min(...eligible.map(change => change.nextAttemptMs)) - now) : null
}

export class BoardController {
  private state: BoardState = { board: null, households: [], pending: [], loading: true, refreshing: false, online: false, error: null }
  private listeners = new Set<() => void>()
  private engine: SyncEngine
  private stopped = false
  private active = true
  private selected: string | undefined
  private mutationRevision = 0
  private readRevision = 0
  private refreshRevision = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private flushing: Promise<void> | null = null
  private refreshAfterSync = false
  private optimistic = new Map<string, { id: string; completed: boolean }>()

  constructor(private readonly store: LocalStore, readonly accountId: string, readonly deviceId: string,
    private readonly api: BoardApi, private readonly uuid: () => string) {
    this.engine = new SyncEngine(store, accountId, api, acknowledged => {
      this.refreshAfterSync ||= acknowledged === true
      this.mutationRevision++
      void this.readLocal().catch(error => this.fail(error))
    })
  }

  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<BoardState>) {
    if (this.stopped) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }
  private fail(error: unknown) { this.update({ error: error instanceof Error ? error.message : "Something went wrong. Please try again." }) }

  async start() {
    try {
      const [boards, selected] = await Promise.all([this.store.getBoards(this.accountId), this.store.setting<string>(this.accountId, "selected-household")])
      if (this.stopped) return
      this.selected = boards.find(board => board.household.id === selected)?.household.id ?? boards[0]?.household.id
      this.update({ households: boards.map(board => board.household) })
      await this.readLocal()
    } catch (error) { this.fail(error) }
    finally { this.update({ loading: false }) }
    if (this.state.online) { void this.refresh(); this.wake() }
  }

  private async readLocal() {
    const revision = ++this.readRevision
    const [cached, pending] = await Promise.all([
      this.selected ? this.store.getBoard(this.accountId, this.selected) : Promise.resolve(null),
      this.store.pending(this.accountId),
    ])
    if (revision !== this.readRevision || this.stopped) return
    const board = cached ? { ...cached, tasks: cached.tasks.map(task => {
      const edit = this.optimistic.get(`${task.occurrence_id}:${task.id}`)
      return edit ? { ...task, status: edit.completed ? "completed" as const : "unlocked" as const } : task
    }) } : null
    this.update({ board, pending })
  }

  setConnectivity(online: boolean) {
    const reconnected = !this.state.online && online
    this.update({ online })
    if (!online) clearTimeout(this.retryTimer)
    if (reconnected && !this.state.loading) { void this.refresh(); this.wake() }
  }

  setActive(active: boolean) {
    this.active = active
    if (!active) clearTimeout(this.retryTimer)
    else if (this.state.online) { void this.refresh(); this.wake() }
  }

  async selectHousehold(householdId: string) {
    this.selected = householdId
    this.refreshRevision++
    await this.store.saveSetting(this.accountId, "selected-household", householdId)
    await this.readLocal()
    await this.refresh()
  }

  async refresh() {
    if (this.stopped || !this.state.online || !this.active) return
    const revision = ++this.refreshRevision
    const mutationAtStart = this.mutationRevision
    this.update({ refreshing: true })
    try {
      let response: BootstrapResult
      try { response = await this.api.bootstrap(this.selected) }
      catch (error) {
        // The selected household may have been removed while this device was offline.
        // Fetch the authoritative membership list before clearing any cached information.
        if (!(error instanceof TransportError) || error.status !== 403 || !this.selected) throw error
        response = await this.api.bootstrap()
      }
      if (this.stopped || revision !== this.refreshRevision) return
      await this.store.reconcileHouseholds(this.accountId, response.households)
      if (this.stopped || revision !== this.refreshRevision) return
      this.update({ households: response.households })
      // An older server read must not overwrite a completion acknowledged while it was in flight.
      const sameHousehold = response.board?.household.id === this.selected
      this.selected = response.board?.household.id
      if (response.board && (!sameHousehold || mutationAtStart === this.mutationRevision)) {
        await this.store.cacheBoard(this.accountId, response.board)
      }
      await this.readLocal()
      this.update({ error: null })
    } catch (error) { if (revision === this.refreshRevision) this.fail(error) }
    finally { if (revision === this.refreshRevision) this.update({ refreshing: false }) }
  }

  async setCompleted(task: BoardTask, memberId: string, completed: boolean) {
    const householdId = this.state.board?.household.id
    if (!householdId || this.stopped) return false
    const id = this.uuid()
    const key = `${task.occurrence_id}:${task.id}`
    this.mutationRevision++
    this.optimistic.set(key, { id, completed })
    this.update({ error: null, board: this.state.board ? { ...this.state.board,
      tasks: this.state.board.tasks.map(item => item.id === task.id && item.occurrence_id === task.occurrence_id
        ? { ...item, status: completed ? "completed" : "unlocked" } : item) } : null })
    try {
      await this.store.enqueueCompletion({ id, accountId: this.accountId, deviceId: this.deviceId, householdId,
        taskId: task.id, occurrenceId: task.occurrence_id, memberId, completed, deviceTimeMs: Date.now() })
      return true
    } catch (error) {
      this.fail(new Error(`This change could not be saved on this device. ${error instanceof Error ? error.message : "Please try again."}`))
      return false
    } finally {
      if (this.optimistic.get(key)?.id === id) this.optimistic.delete(key)
      await this.readLocal().catch(error => this.fail(error))
      this.wake()
    }
  }

  async retry(change: CompletionChange) {
    await this.store.retryRejected(this.accountId, change.id)
    await this.readLocal()
    this.wake()
  }

  async discard(change: CompletionChange) {
    const revoked = await this.store.isHouseholdRevoked(this.accountId, change.householdId)
    const result = revoked ? null : await this.api.bootstrap(change.householdId)
    if (!revoked && !result?.board) throw new Error("Connect to refresh this household before discarding the change.")
    let run: RunSnapshot | null | undefined
    if (!revoked && this.api.run && await this.store.getRun(this.accountId, change.householdId, change.occurrenceId)) {
      try { run = await this.api.run(change.householdId, change.occurrenceId) }
      catch (error) { if (error instanceof TransportError && error.status === 404) run = null; else throw error }
    }
    this.mutationRevision++
    await this.store.discardRejected(this.accountId, change.id, result?.board ?? null, run)
    await this.readLocal()
    this.wake()
  }

  private wake() {
    clearTimeout(this.retryTimer)
    if (this.stopped || !this.active || !this.state.online || this.flushing) return
    this.flushing = this.engine.flush().catch(error => this.fail(error)).finally(async () => {
      this.flushing = null
      await this.readLocal().catch(error => this.fail(error))
      if (this.stopped || !this.active || !this.state.online) return
      // Once per changed batch, fetch task metadata and routine visibility too.
      // This also replaces a reconnect refresh skipped during local writes.
      if (this.refreshAfterSync) {
        this.refreshAfterSync = false
        void this.refresh()
      }
      const delay = nextSyncDelay(this.state.pending, Date.now())
      if (delay !== null) this.retryTimer = setTimeout(() => this.wake(), Math.max(50, delay))
    })
  }

  stop() {
    this.stopped = true
    this.engine.stop()
    clearTimeout(this.retryTimer)
    this.listeners.clear()
  }
}
