import type { BoardSnapshot, BoardTask, HouseholdSummary } from "../../../shared/mobile/contracts"
import { summarizeRun, type RunPage, type RunSnapshot, type RunView } from "../../../shared/mobile/runs"
import type { LocalStore } from "../storage/local-store"
import { TransportError } from "../storage/sync-engine"
import type { BoardController, BoardState } from "./board-controller"

interface RunsApi {
  runs(householdId: string, view: RunView, cursor?: string): Promise<RunPage>
  run(householdId: string, occurrenceId: string): Promise<RunSnapshot>
  renameRun(householdId: string, occurrenceId: string, title: string): Promise<string>
  deleteRun(householdId: string, occurrenceId: string): Promise<void>
}
export interface RunsState {
  household: HouseholdSummary | null; view: RunView; page: RunPage | null; runId: string | null; run: RunSnapshot | null;
  loading: boolean; refreshing: boolean; runLoading: boolean; error: string | null; runError: string | null;
  focusedTaskId: string | null; managing: "rename" | "delete" | null;
}
export class RunsController {
  private state: RunsState = { household: null, view: "active", page: null, runId: null, run: null, loading: false, refreshing: false, runLoading: false, error: null, runError: null, focusedTaskId: null, managing: null }
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
  constructor(private readonly store: LocalStore, private readonly accountId: string, private readonly api: RunsApi, private readonly board: BoardController,
    private readonly canManage: (householdId: string) => boolean = () => true) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<RunsState>) { if (!this.stopped) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()) } }
  private report(error: unknown, detail = false) { this.update({ [detail ? "runError" : "error"]: error instanceof Error ? error.message : "Unable to load these runs." }) }
  invalidateCreationReads() {
    this.pageRevision++; this.runRevision++; this.localRevision++
    this.update({ refreshing: false, runLoading: false })
  }
  async reloadAfterCreation() {
    this.invalidateCreationReads()
    await this.readLocal()
    await this.refresh()
  }
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
      this.update({ household, page: null, runId: null, run: null, focusedTaskId: null, loading: Boolean(household), refreshing: false, runLoading: false, error: null, runError: null })
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
    if (!household || !this.online || !this.visible || !this.active || this.stopped || this.state.managing || (more && (!page?.nextCursor || this.state.refreshing))) return
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
  async openRun(id: string, focusedTaskId?: string) {
    this.runRevision++; this.update({ runId: id, run: null, focusedTaskId: focusedTaskId ?? null, runLoading: true, runError: null })
    await this.readLocal()
    if (!this.online) this.update({ runLoading: false, runError: this.state.run ? null : "Connect once to save this run’s details on this device." })
    else await this.refreshRun()
  }
  closeRun() { this.runRevision++; this.localRevision++; this.update({ runId: null, run: null, focusedTaskId: null, runLoading: false, runError: null }) }
  async refreshRun() {
    const { household, runId } = this.state
    if (!household || !runId || !this.online || !this.visible || !this.active || this.stopped || this.state.managing) return
    const revision = ++this.runRevision
    this.update({ runLoading: true, runError: null })
    try {
      const next = await this.api.run(household.id, runId)
      if (this.stopped || revision !== this.runRevision || household.id !== this.state.household?.id) return
      if (next.household.id !== household.id || next.run.id !== runId) throw new Error("The run did not match this household.")
      await this.store.cacheRun(this.accountId, next); await this.readLocal()
    } catch (error) {
      if (revision !== this.runRevision) return
      if (error instanceof TransportError && [403, 404].includes(error.status)) {
        await this.store.removeRun(this.accountId, household.id, runId); await this.readLocal()
        if (error.status === 403) void this.board.refresh()
      }
      this.report(error, true)
    } finally { if (revision === this.runRevision) this.update({ runLoading: false }) }
  }
  async setCompleted(task: BoardTask, memberId: string, completed: boolean) {
    if (this.state.managing || !this.state.run || this.state.run.run.id !== task.occurrence_id || this.state.household?.id !== this.board.getSnapshot().board?.household.id) return
    const key = `${task.occurrence_id}:${task.id}`, id = ++this.editSequence
    this.optimistic.set(key, { id, completed })
    this.update({ runError: null, run: summarizeRun({ ...this.state.run, tasks: this.state.run.tasks.map(item => item.id === task.id ? { ...item, status: completed ? "completed" : "unlocked" } : item) }) })
    try { if (!await this.board.setCompleted(task, memberId, completed)) this.report(new Error(this.board.getSnapshot().error ?? "Unable to save this change."), true) }
    finally { if (this.optimistic.get(key)?.id === id) this.optimistic.delete(key); await this.readLocal() }
  }
  renameRun(occurrenceId: string, title: string) {
    if (!title.trim()) return Promise.reject(new Error("Enter a name for this run."))
    return this.manageRun(occurrenceId, "rename", title.trim())
  }
  deleteRun(occurrenceId: string) { return this.manageRun(occurrenceId, "delete") }
  private async manageRun(occurrenceId: string, action: "rename" | "delete", title = "") {
    const household = this.state.household
    const current = () => !this.stopped && household && this.state.household?.id === household.id && this.canManage(household.id)
      && this.state.household.role !== "member" && this.board.getSnapshot().board?.household.id === household.id
    if (!current() || !household || !this.active || !this.visible || this.state.runId !== occurrenceId || !this.state.run) {
      throw new Error("Open this run with parent access before changing it.")
    }
    if (!this.online) throw new Error("Connect to rename or delete a run. You can still update saved tasks offline.")
    if (this.state.managing) throw new Error("Wait for the current run change to finish.")
    this.pageRevision++; this.runRevision++; this.localRevision++
    this.update({ managing: action, refreshing: false, runLoading: false, runError: null })
    try {
      const savedTitle = action === "rename" ? await this.api.renameRun(household.id, occurrenceId, title) : await this.api.deleteRun(household.id, occurrenceId)
      if (!current()) return false
      // Invalidate Today before the cache transaction as well as after it. Any
      // already-admitted cache write precedes this transaction in SQLite's queue.
      await this.board.reloadAfterRunChange()
      if (action === "rename") await this.store.renameRun(this.accountId, household.id, occurrenceId, savedTitle as string)
      else await this.store.removeRun(this.accountId, household.id, occurrenceId)
      if (!current()) return false
      this.pageRevision++; this.runRevision++; this.localRevision++
      await this.board.reloadAfterRunChange()
      if (action === "delete" && this.state.runId === occurrenceId) this.closeRun()
      await this.readLocal()
      return true
    } catch (error) {
      if (current()) this.report(error, true)
      throw error
    } finally { this.update({ managing: null }) }
  }
  stop() { this.stopped = true; this.pageRevision++; this.runRevision++; this.localRevision++; this.listeners.clear() }
}
