import type { HouseholdSummary } from "../../../shared/mobile/contracts"
import { validateRunDraft, type RunEdit, type RunEditorSnapshot, type RunTaskDraft } from "../../../shared/mobile/run-editor"
import type { RunEditorStore } from "../storage/run-editor-store"
import { TransportError } from "../storage/sync-engine"

interface RunEditorApi {
  runEditor(householdId: string, occurrenceId: string): Promise<RunEditorSnapshot>
  saveRunEdit(edit: RunEdit): Promise<unknown>
  deleteRunTask(householdId: string, occurrenceId: string, taskId: string): Promise<void>
}
export interface RunEditorState {
  household: HouseholdSummary | null; occurrenceId: string | null; data: RunEditorSnapshot | null; draft: RunTaskDraft | null;
  pending: RunEdit[]; online: boolean; loading: boolean; busy: boolean; draftSaving: boolean; error: string | null
}
export class RunEditorController {
  private state: RunEditorState = { household: null, occurrenceId: null, data: null, draft: null, pending: [], online: false, loading: false, busy: false, draftSaving: false, error: null }
  private listeners = new Set<() => void>()
  private active = true
  private stopped = false
  private generation = 0
  private reads = 0
  private mutations = 0
  private draftRevision = 0
  private draftDirty = false
  private localReads = 0
  private flushing: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly store: RunEditorStore, private readonly accountId: string, private readonly deviceId: string,
    private readonly api: RunEditorApi, private readonly uuid: () => string, private readonly onSynced?: () => Promise<void>,
    private readonly beforeAcknowledged?: () => void,
    private readonly onTaskDeleted?: (householdId: string, occurrenceId: string, taskId: string) => Promise<void>) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<RunEditorState>) { if (!this.stopped) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()) } }
  private report(error: unknown) { this.update({ error: error instanceof Error ? error.message : "Unable to save this task board." }) }
  async start() { await this.readLocal(); this.wake() }
  private async readLocal() {
    const read = ++this.localReads, generation = this.generation, draftRevision = this.draftRevision, { household, occurrenceId } = this.state
    const [pending, data, draft] = await Promise.all([this.store.pending(this.accountId),
      household && occurrenceId ? this.store.get(this.accountId, household.id, occurrenceId) : null,
      household && occurrenceId ? this.store.draft(this.accountId, household.id, occurrenceId) : null])
    if (read !== this.localReads || generation !== this.generation || this.stopped) return
    this.update({ pending, data, ...(draftRevision === this.draftRevision && !this.draftDirty ? { draft } : {}) })
  }
  observe(household: HouseholdSummary | null) {
    if (this.state.household && (household?.id !== this.state.household.id || household.role === "member")) this.close()
    void this.readLocal().catch(error => this.report(error))
  }
  async open(household: HouseholdSummary, occurrenceId: string) {
    if (this.stopped || household.role === "member") throw new Error("Open this board with parent access to edit its tasks.")
    const generation = ++this.generation
    const allowed = await this.store.allowed(this.accountId, household.id)
    if (this.stopped || generation !== this.generation) return
    if (!allowed) throw new Error("Open this board with parent access to edit its tasks.")
    this.reads++; this.draftRevision++
    this.draftDirty = false
    this.update({ household, occurrenceId, data: null, draft: null, loading: true, busy: false, draftSaving: false, error: null })
    await this.readLocal(); await this.refresh()
    if (generation === this.generation && !this.state.online) this.update({ loading: false, error: this.state.data ? null : "Connect once to load this task board’s editing details." })
  }
  close() { this.generation++; this.reads++; this.localReads++; this.draftRevision++; this.update({ household: null, occurrenceId: null, data: null, draft: null, loading: false, busy: false, draftSaving: false, error: null }) }
  setConnectivity(online: boolean) {
    const recovered = online && !this.state.online
    this.update({ online }); clearTimeout(this.timer)
    if (recovered) { void this.refresh(); this.wake() }
  }
  setActive(active: boolean) { this.active = active; clearTimeout(this.timer); if (active) { void this.refresh(); this.wake() } }
  async refresh() {
    const { household, occurrenceId } = this.state
    if (!household || !occurrenceId || !this.state.online || !this.active || this.stopped) return
    const read = ++this.reads, generation = this.generation, mutation = this.mutations
    this.update({ loading: true })
    try {
      const data = await this.api.runEditor(household.id, occurrenceId)
      if (read !== this.reads || generation !== this.generation || mutation !== this.mutations || this.stopped) return
      await this.store.cache(this.accountId, household.id, occurrenceId, data); await this.readLocal()
    } catch (error) {
      if (generation === this.generation && read === this.reads) {
        if (error instanceof TransportError && [403, 404, 410].includes(error.status)) {
          await this.store.invalidate(this.accountId, household.id, occurrenceId); await this.readLocal()
        }
        this.report(error)
      }
    }
    finally { if (generation === this.generation && read === this.reads) this.update({ loading: false }) }
  }
  async setDraft(draft: RunTaskDraft | null) {
    const { household, occurrenceId } = this.state
    if (!household || !occurrenceId || this.stopped || this.state.busy) return
    const revision = ++this.draftRevision, generation = this.generation
    this.draftDirty = true
    this.update({ draft, draftSaving: true, error: null })
    try { await this.store.saveDraft(this.accountId, household.id, occurrenceId, draft); if (generation === this.generation && revision === this.draftRevision) this.draftDirty = false }
    catch (error) { if (generation === this.generation && revision === this.draftRevision) { this.report(new Error(`Draft not saved on this device. ${error instanceof Error ? error.message : "Please try again."}`)); throw error } }
    finally { if (generation === this.generation && revision === this.draftRevision) this.update({ draftSaving: false }) }
  }
  async save(draft: RunTaskDraft) {
    const { household, occurrenceId } = this.state
    if (!household || !occurrenceId || draft.occurrenceId !== occurrenceId || this.stopped) throw new Error("Reopen the task board before saving.")
    if (this.state.busy) throw new Error("This task is still saving.")
    if (draft.isNew && !this.state.online) throw new Error("Connect to add a task. Your draft stays on this device.")
    validateRunDraft(draft)
    const generation = this.generation
    this.mutations++; this.draftRevision++; this.update({ busy: true, error: null })
    try {
      await this.store.enqueue(this.accountId, household.id, this.deviceId, this.uuid(), draft)
      if (generation === this.generation) { this.draftDirty = false; this.update({ draft: null, draftSaving: false }); await this.readLocal() }
      this.wake()
    } catch (error) { if (generation === this.generation) this.report(error); throw error }
    finally { if (generation === this.generation) this.update({ busy: false, draftSaving: false }) }
  }
  private wake() {
    clearTimeout(this.timer)
    if (!this.active || !this.state.online || this.stopped || this.flushing) return
    void this.flush().catch(error => this.report(error))
  }
  private flush(): Promise<void> {
    if (this.flushing) return this.flushing
    let changed = false
    this.flushing = (async () => {
      const edits = await this.store.pending(this.accountId)
      for (const edit of edits) {
        if (this.stopped || !this.active || !this.state.online) break
        if (edit.state !== "pending" || edit.nextAttemptMs > Date.now() || !await this.store.allowed(this.accountId, edit.householdId)) continue
        if (!(await this.store.pending(this.accountId)).some(current => current.id === edit.id && current.state === "pending")) continue
        try {
          const result = await this.api.saveRunEdit(edit)
          if (this.stopped) return
          this.beforeAcknowledged?.(); this.mutations++; this.reads++
          await this.store.acknowledge(edit, result); changed = true
        } catch (error) {
          if (this.stopped) return
          const rejected = error instanceof TransportError && [400, 402, 403, 404, 409, 410, 422].includes(error.status)
          await this.store.fail(edit, error instanceof Error ? error.message : "Waiting for a connection", rejected)
        }
        await this.readLocal()
      }
      await this.readLocal()
    })().finally(async () => {
      this.flushing = null
      if (this.stopped || !this.active || !this.state.online) return
      if (changed) { void this.refresh(); if (this.onSynced) void this.onSynced().catch(error => this.report(error)) }
      const eligible: RunEdit[] = []
      for (const edit of await this.store.pending(this.accountId)) if (edit.state === "pending" && await this.store.allowed(this.accountId, edit.householdId)) eligible.push(edit)
      if (!this.stopped && this.active && this.state.online && eligible.length) this.timer = setTimeout(() => this.wake(), Math.max(50, Math.min(...eligible.map(edit => edit.nextAttemptMs)) - Date.now()))
    })
    return this.flushing
  }
  async retry(edit: RunEdit) { await this.store.retry(this.accountId, edit); await this.readLocal(); this.wake() }
  async deleteTask(taskId: string) {
    const { household, occurrenceId, data } = this.state
    if (!household || !occurrenceId || !data?.tasks.some(task => task.id === taskId) || !this.onTaskDeleted || this.stopped)
      throw new Error("Open this task board with parent access before deleting a task.")
    if (!this.state.online) throw new Error("Connect to delete a task.")
    if (this.state.busy || this.state.draft) throw new Error("Finish editing before deleting a task.")
    if (data.occurrence.status === "cancelled") throw new Error("A cancelled run cannot be edited.")
    const generation = this.generation
    this.mutations++; this.reads++; this.update({ busy: true, error: null })
    try {
      const [allowed, pending] = await Promise.all([this.store.allowed(this.accountId, household.id), this.store.pending(this.accountId)])
      if (this.stopped || generation !== this.generation) return
      if (!allowed) throw new Error("Parent access to this household is required.")
      if (!this.state.online) throw new Error("Connect to delete a task.")
      if (pending.some(edit => edit.householdId === household.id && edit.draft.occurrenceId === occurrenceId)) throw new Error("Sync or review saved changes to this board before deleting a task.")
      await this.api.deleteRunTask(household.id, occurrenceId, taskId)
      if (this.stopped) return
      this.beforeAcknowledged?.(); this.mutations++; this.reads++
      // The server may finish after navigation. Apply its result to the original
      // board cache without changing whichever editor is now open.
      await this.onTaskDeleted(household.id, occurrenceId, taskId)
      if (generation === this.generation) { await this.readLocal(); await this.refresh() }
      if (this.onSynced) void this.onSynced().catch(error => this.report(error))
    } catch (error) { if (generation === this.generation) this.report(error); throw error }
    finally { if (generation === this.generation) this.update({ busy: false }) }
  }
  async discard(edit: RunEdit) {
    const fresh = this.state.online && await this.store.allowed(this.accountId, edit.householdId)
      ? await this.api.runEditor(edit.householdId, edit.draft.occurrenceId).catch(async error => { if (error instanceof TransportError && [403, 404, 410].includes(error.status)) { await this.store.invalidate(this.accountId, edit.householdId, edit.draft.occurrenceId); return null }; throw error }) : null
    this.mutations++; this.reads++
    await this.store.discard(this.accountId, edit, fresh); await this.readLocal()
  }
  stop() { this.stopped = true; this.generation++; clearTimeout(this.timer); this.listeners.clear() }
}
