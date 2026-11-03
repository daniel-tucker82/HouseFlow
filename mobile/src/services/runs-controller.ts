import type { BoardSnapshot, BoardTask, HouseholdSummary } from "../../../shared/mobile/contracts"
import { summarizeRun, type RunPage, type RunSnapshot, type RunView } from "../../../shared/mobile/runs"
import type { LocalStore } from "../storage/local-store"
import { TransportError } from "../storage/sync-engine"
import type { BoardController, BoardState } from "./board-controller"

interface RunsApi { runs(householdId: string, view: RunView, cursor?: string): Promise<RunPage>; run(householdId: string, occurrenceId: string): Promise<RunSnapshot> }
export interface RunsState {
  household: HouseholdSummary | null; view: RunView; page: RunPage | null; runId: string | null; run: RunSnapshot | null;
  loading: boolean; refreshing: boolean; runLoading: boolean; error: string | null; runError: string | null;
}
export class RunsController {
  private state: RunsState = { household: null, view: "active", page: null, runId: null, run: null, loading: false, refreshing: false, runLoading: false, error: null, runError: null }
  private listeners = new Set<() => void>()
  private visible = false
  private active = true
  private stopped = false
  private online = false
  private pageRevision = 0
  private runRevision = 0
  private localRevision = 0
  private pendingKey = ""
  private pendingCount = 0
  private observedBoard: BoardSnapshot | null = null
  private optimistic = new Map<string, { id: number; completed: boolean }>()
  private editSequence = 0
  constructor(private readonly store: LocalStore, private readonly accountId: string, private readonly api: RunsApi, private readonly board: BoardController) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<RunsState>) { if (!this.stopped) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()) } }
  private report(error: unknown, detail = false) { this.update({ [detail ? "runError" : "error"]: error instanceof Error ? error.message : "Unable to load these runs." }) }
  observe(state: BoardState) {
    const household = state.board?.household ?? null, switched = household?.id !== this.state.household?.id
    const reconnected = !this.online && state.online
    const boardChanged = state.board !== this.observedBoard
    const refreshed = state.board?.fetchedAt !== this.observedBoard?.fetchedAt
    this.observedBoard = state.board
    this.online = state.online
    const key = state.pending.map(change => `${change.id}:${change.state}:${change.attempts}`).join(";")
    const changed = key !== this.pendingKey, acknowledged = state.pending.length < this.pendingCount
    this.pendingKey = key; this.pendingCount = state.pending.length
    if (switched) {
      this.pageRevision++; this.runRevision++; this.localRevision++; this.optimistic.clear()
      this.update({ household, page: null, runId: null, run: null, loading: Boolean(household), refreshing: false, runLoading: false, error: null, runError: null })
    } else if (boardChanged) this.update({ household })
    if (switched || changed || boardChanged) void this.readLocal().catch(error => this.report(error))
    if (this.visible && this.active && this.online && (switched || reconnected || acknowledged || refreshed)) { void this.refresh(); if (this.state.runId) void this.refreshRun() }
  }
  setVisible(visible: boolean) {
    this.visible = visible
    if (visible) { void this.readLocal().catch(error => this.report(error)); void this.refresh(); if (this.state.runId) void this.refreshRun() }
  }
  setActive(active: boolean) { this.active = active; if (active && this.visible) { void this.refresh(); if (this.state.runId) void this.refreshRun() } }
  private async readLocal() {
    const revision = ++this.localRevision, { household, view, runId } = this.state
    if (!household) { this.update({ loading: false }); return }
    const [page, stored] = await Promise.all([this.store.getRunPage(this.accountId, household.id, view), runId ? this.store.getRun(this.accountId, household.id, runId) : null])
    if (revision !== this.localRevision || household.id !== this.state.household?.id || view !== this.state.view || runId !== this.state.runId) return
    const run = stored ? summarizeRun({ ...stored, tasks: stored.tasks.map(task => {
      const edit = this.optimistic.get(`${task.occurrence_id}:${task.id}`)
      return edit ? { ...task, status: edit.completed ? "completed" : "unlocked" } : task
    }) }) : null
    this.update({ page, run, loading: false })
  }
  async selectView(view: RunView) {
    this.pageRevision++; this.update({ view, page: null, loading: true, refreshing: false, error: null })
    await this.readLocal(); await this.refresh()
  }
  async refresh(more = false) {
    const { household, view, page } = this.state
    if (!household || !this.online || !this.visible || !this.active || this.stopped || (more && (!page?.nextCursor || this.state.refreshing))) return
    const revision = ++this.pageRevision
    this.update({ refreshing: true, error: null })
    try {
      const next = await this.api.runs(household.id, view, more ? page!.nextCursor! : undefined)
      if (this.stopped || revision !== this.pageRevision || household.id !== this.state.household?.id) return
      if (next.householdId !== household.id || next.view !== view) throw new Error("The run list did not match this household.")
      await this.store.cacheRunPage(this.accountId, next, more); await this.readLocal()
    } catch (error) { if (revision === this.pageRevision) this.report(error) }
    finally { if (revision === this.pageRevision) this.update({ refreshing: false, loading: false }) }
  }
  async openRun(id: string) {
    this.runRevision++; this.update({ runId: id, run: null, runLoading: true, runError: null })
    await this.readLocal()
    if (!this.online) this.update({ runLoading: false, runError: this.state.run ? null : "Connect once to save this run’s details on this device." })
    else await this.refreshRun()
  }
  closeRun() { this.runRevision++; this.localRevision++; this.update({ runId: null, run: null, runLoading: false, runError: null }) }
  async refreshRun() {
    const { household, runId } = this.state
    if (!household || !runId || !this.online || !this.visible || !this.active || this.stopped) return
    const revision = ++this.runRevision
    this.update({ runLoading: true, runError: null })
    try {
      const next = await this.api.run(household.id, runId)
      if (this.stopped || revision !== this.runRevision || household.id !== this.state.household?.id) return
      if (next.household.id !== household.id || next.run.id !== runId) throw new Error("The run did not match this household.")
      await this.store.cacheRun(this.accountId, next); await this.readLocal()
    } catch (error) {
      if (revision !== this.runRevision) return
      if (error instanceof TransportError && error.status === 404) { await this.store.removeRun(this.accountId, household.id, runId); await this.readLocal() }
      this.report(error, true)
    } finally { if (revision === this.runRevision) this.update({ runLoading: false }) }
  }
  async setCompleted(task: BoardTask, memberId: string, completed: boolean) {
    if (!this.state.run || this.state.run.run.id !== task.occurrence_id || this.state.household?.id !== this.board.getSnapshot().board?.household.id) return
    const key = `${task.occurrence_id}:${task.id}`, id = ++this.editSequence
    this.optimistic.set(key, { id, completed })
    this.update({ runError: null, run: summarizeRun({ ...this.state.run, tasks: this.state.run.tasks.map(item => item.id === task.id ? { ...item, status: completed ? "completed" : "unlocked" } : item) }) })
    try { if (!await this.board.setCompleted(task, memberId, completed)) this.report(new Error(this.board.getSnapshot().error ?? "Unable to save this change."), true) }
    finally { if (this.optimistic.get(key)?.id === id) this.optimistic.delete(key); await this.readLocal() }
  }
  stop() { this.stopped = true; this.pageRevision++; this.runRevision++; this.localRevision++; this.listeners.clear() }
}
