import type { HouseholdSummary } from "../../../shared/mobile/contracts"
import { applyPlannerDraft, validatePlannerDraft, type PlannerCreation, type PlannerEdit, type PlannerSnapshot, type PlannerTaskDraft } from "../../../shared/mobile/planner"
import type { PlannerStore } from "../storage/planner-store"
import { TransportError } from "../storage/sync-engine"
import { scheduleForRoutine, validateRoutineSchedule, type RoutineScheduleDraft } from "../../../shared/routine-schedule"
import type { Routine } from "../../../lib/types"

interface PlannerApi {
  planner(householdId: string): Promise<PlannerSnapshot>
  savePlannerEdit(edit: PlannerEdit): Promise<unknown>
  request<T>(path: string, body?: Record<string, unknown>): Promise<T>
}
export interface PlannerState {
  household: HouseholdSummary | null; data: PlannerSnapshot | null; pending: PlannerEdit[];
  creations: PlannerCreation[];
  loading: boolean; busy: boolean; online: boolean; error: string | null
}

export class PlannerController {
  private state: PlannerState = { household: null, data: null, pending: [], creations: [], loading: false, busy: false, online: false, error: null }
  private listeners = new Set<() => void>()
  private stopped = false
  private active = true
  private reads = 0
  private localReads = 0
  private mutations = 0
  private flushing: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private optimistic = new Map<string, { id: string; draft: PlannerTaskDraft }>()
  private saves = new Set<Promise<void>>()
  constructor(private readonly store: PlannerStore, private readonly accountId: string, private readonly deviceId: string,
    private readonly api: PlannerApi, private readonly uuid: () => string, private readonly onSynced?: () => Promise<void>) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<PlannerState>) {
    if (this.stopped) return
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener())
  }
  private report(error: unknown) { this.update({ error: error instanceof Error ? error.message : "Unable to load your routines." }) }
  private async readLocal() {
    const revision = ++this.localReads
    const householdId = this.state.household?.id
    const [data, pending, creations] = await Promise.all([householdId ? this.store.get(this.accountId, householdId) : null, this.store.pending(this.accountId), this.store.creations(this.accountId)])
    if (revision !== this.localReads || householdId !== this.state.household?.id || this.stopped) return
    this.update({ data: data ? [...this.optimistic.values()].reduce((next, edit) => applyPlannerDraft(next, edit.draft), data) : null, pending, creations })
  }
  async selectHousehold(household: HouseholdSummary | null) {
    const selected = household?.role !== "member" ? household : null
    if (selected?.id === this.state.household?.id && selected?.role === this.state.household?.role) {
      // Permission reconciliation can change retained queues even with no current household.
      if (!selected) await this.readLocal()
      return
    }
    this.reads++; this.update({ household: selected, data: null, error: null, loading: Boolean(selected) })
    try { await this.readLocal(); await this.refresh() } catch (error) { this.report(error) }
    finally { this.update({ loading: false }); this.wake() }
  }
  setConnectivity(online: boolean) {
    const reconnected = !this.state.online && online
    this.update({ online })
    if (!online) clearTimeout(this.timer)
    else if (reconnected) { void this.refresh(); this.wake() }
  }
  setActive(active: boolean) {
    this.active = active
    if (!active) clearTimeout(this.timer)
    else if (this.state.online) { void this.refresh(); this.wake() }
  }
  async refresh() {
    const householdId = this.state.household?.id
    if (!householdId || !this.state.online || !this.active || this.stopped || this.flushing) return
    const request = ++this.reads, mutation = this.mutations
    this.update({ loading: !this.state.data })
    try {
      const data = await this.api.planner(householdId)
      if (this.stopped || request !== this.reads || mutation !== this.mutations || this.flushing) return
      await this.store.cache(this.accountId, householdId, data)
      await this.readLocal(); this.update({ error: null })
    } catch (error) { if (request === this.reads) this.report(error) }
    finally { if (request === this.reads) this.update({ loading: false }) }
  }
  async saveTask(draft: PlannerTaskDraft) {
    validatePlannerDraft(draft)
    const householdId = this.state.household?.id
    if (!householdId || this.stopped) throw new Error("Choose a household you can manage.")
    if (this.state.busy) throw new Error("Another change is still saving.")
    const id = this.uuid()
    this.mutations++
    this.optimistic.set(draft.taskId, { id, draft })
    this.update({ error: null, data: this.state.data ? applyPlannerDraft(this.state.data, draft) : null })
    const save = this.store.enqueue(this.accountId, householdId, this.deviceId, id, draft)
    this.saves.add(save)
    try { await save }
    catch (error) { this.report(error); throw error }
    finally {
      this.saves.delete(save)
      if (this.optimistic.get(draft.taskId)?.id === id) this.optimistic.delete(draft.taskId)
      await this.readLocal(); this.wake()
    }
  }
  async create(action: "createRoutine" | "createTask" | "createOccurrence" | "saveRoutineSchedule", values: Record<string, unknown>, label: string, replacesId?: string) {
    const household = this.state.household
    if (!household || this.stopped) throw new Error("Choose a household you can manage.")
    if (this.state.busy) throw new Error("Another change is still saving.")
    if (action === "createOccurrence" && !this.state.online) throw new Error("Connect to start a routine.")
    this.update({ busy: true })
    const id = this.uuid()
    const creation: PlannerCreation = { id, accountId: this.accountId, householdId: household.id, label,
      body: { ...values, action, householdId: household.id, timezone: household.timezone, creationId: id },
      state: "pending", attempts: 0, nextAttemptMs: 0, error: null }
    this.mutations++
    try {
      // Only await local writes. Starting must not sit behind a network timeout;
      // the atomic store guard explains any earlier changes still awaiting sync.
      if (action === "createOccurrence") await Promise.all(this.saves)
      if (this.stopped) return
      await this.store.enqueueCreation(creation, replacesId); await this.readLocal(); this.wake()
    }
    finally { this.update({ busy: false }) }
  }
  private wake() {
    clearTimeout(this.timer)
    if (!this.active || !this.state.online || this.stopped || this.flushing) return
    void this.flush().catch(error => this.report(error))
  }
  private flush(): Promise<void> {
    if (this.flushing) return this.flushing
    if (!this.state.online || !this.active || this.stopped) return Promise.resolve()
    let changed = false
    this.flushing = (async () => {
      const edits = (await this.store.pending(this.accountId)).filter(edit => edit.state === "pending" && edit.nextAttemptMs <= Date.now())
      for (const edit of edits) {
        if (this.stopped || !this.state.online || !this.active) break
        // Recheck coalesced IDs and permissions just before transmission.
        if (!(await this.store.pending(this.accountId)).some(current => current.id === edit.id && current.state === "pending")) continue
        try {
          if (!await this.store.allowed(this.accountId, edit.householdId)) continue
          await this.api.savePlannerEdit(edit)
          if (this.stopped) return
          await this.store.acknowledge(edit); changed = true; this.mutations++
        } catch (error) {
          if (this.stopped) return
          const rejected = error instanceof TransportError && [400, 402, 403, 404, 409, 410, 422].includes(error.status)
          await this.store.fail(edit, error instanceof Error ? error.message : "Waiting for a connection", rejected, Date.now())
        }
        await this.readLocal()
      }
      const creations = (await this.store.creations(this.accountId)).filter(item => item.state === "pending" && item.nextAttemptMs <= Date.now())
      for (const creation of creations) {
        if (this.stopped || !this.state.online || !this.active) break
        if (!await this.store.allowed(this.accountId, creation.householdId)) continue
        if (!(await this.store.creations(this.accountId)).some(current => current.id === creation.id && current.state === "pending")) continue
        try {
          const result = await this.api.request<{ routine?: Routine }>("/api/leader/flow", creation.body)
          if (this.stopped) return
          await this.store.acknowledgeCreation(this.accountId, creation.id, result); changed = true; this.mutations++
        } catch (error) {
          if (this.stopped) return
          const rejected = error instanceof TransportError && [400, 402, 403, 404, 409, 410, 422].includes(error.status)
          await this.store.failCreation(creation, error instanceof Error ? error.message : "Waiting for a connection", rejected, Date.now())
        }
        await this.readLocal()
      }
      await this.readLocal()
    })().finally(() => {
      this.flushing = null
      if (!this.active || !this.state.online || this.stopped) return
      if (changed) {
        void this.refresh()
        // Refresh Today after the durable acknowledgement. A refresh failure
        // must never turn a successful creation into a failed request.
        if (this.onSynced) void this.onSynced().catch(error => this.report(error))
      }
      const pending = [...this.state.pending, ...this.state.creations].filter(edit => edit.state === "pending")
      if (pending.length) this.timer = setTimeout(() => this.wake(), Math.max(50, Math.min(...pending.map(edit => edit.nextAttemptMs)) - Date.now()))
    })
    return this.flushing
  }
  async retry(edit: PlannerEdit) { await this.store.retry(this.accountId, edit); await this.readLocal(); this.wake() }
  async retryCreation(creation: PlannerCreation) { await this.store.retryCreation(this.accountId, creation); await this.readLocal(); this.wake() }
  async discardCreation(creation: PlannerCreation) { await this.store.discardCreation(this.accountId, creation.id); await this.readLocal(); void this.refresh() }
  async reviewSchedule(creation: PlannerCreation): Promise<RoutineScheduleDraft> {
    if (!this.state.online || this.stopped) throw new Error("Connect to review the household’s current schedule.")
    if (!await this.store.allowed(this.accountId, creation.householdId)) throw new Error("You no longer have permission to manage this household.")
    const saved = (await this.store.creations(this.accountId)).find(item => item.id === creation.id && item.state === "rejected" && item.body.action === "saveRoutineSchedule")
    if (!saved) throw new Error("This request has changed. Refresh your routines.")
    const fresh = await this.api.planner(saved.householdId)
    const routine = fresh.routines.find(item => item.id === saved.body.routineId)
    if (!routine) throw new Error("This routine was removed. You can discard its saved schedule.")
    validateRoutineSchedule(saved.body.schedule)
    await this.store.cache(this.accountId, saved.householdId, fresh); await this.readLocal()
    return { routineId: routine.id, routineName: routine.name, baseSchedule: scheduleForRoutine(routine), schedule: saved.body.schedule, replacesId: saved.id }
  }
  async discard(edit: PlannerEdit) {
    const allowed = await this.store.allowed(this.accountId, edit.householdId)
    const fresh = allowed ? await this.api.planner(edit.householdId) : null
    this.mutations++; this.reads++
    await this.store.discard(this.accountId, edit, fresh); await this.readLocal()
  }
  async run<T>(action: string, values: Record<string, unknown> = {}): Promise<T> {
    if (action === "createOccurrence") throw new Error("Routine starts must use a saved start request.")
    const household = this.state.household
    if (!household || !this.state.online) throw new Error("Connect to make this change.")
    if (this.state.busy) throw new Error("Another change is still saving.")
    this.update({ busy: true, error: null })
    try {
      await Promise.all(this.saves)
      await this.flush()
      if ([...await this.store.pending(this.accountId), ...await this.store.creations(this.accountId)].some(edit => edit.householdId === household.id)) throw new Error("Sync or review your saved task edits before continuing.")
      this.mutations++
      const result = await this.api.request<T>("/api/leader/flow", { ...values, action, householdId: household.id, timezone: household.timezone })
      this.mutations++; await this.refresh()
      return result
    } catch (error) { this.report(error); throw error }
    finally { this.update({ busy: false }) }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.listeners.clear() }
}
