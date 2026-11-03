import type { HouseholdSummary } from "../../../shared/mobile/contracts"
import type { DeviceNotificationPreferences } from "../../../shared/mobile/notification-catalog"
import { notificationHistoryFilterKey, notificationHistorySelections, type NotificationHistoryAction, type NotificationHistoryItem,
  type NotificationHistoryPage, type NotificationHistoryScope, type NotificationHistorySource } from "../../../shared/mobile/notification-history"
import type { NotificationHistoryStore } from "../storage/notification-history-store"
import { TransportError } from "../storage/sync-engine"

interface HistoryApi {
  notificationHistory(householdId: string, source: NotificationHistorySource, cursor?: string): Promise<NotificationHistoryPage>
  updateNotificationHistory(action: NotificationHistoryAction): Promise<unknown>
}
function remainingRetry(nextAttemptMs: number, now: number) {
  const remaining = nextAttemptMs - now
  // Backoff is at most a minute. A larger gap means the wall clock moved.
  return remaining > 0 && remaining <= 60_000 ? remaining : 0
}
export interface NotificationHistoryState {
  household: HouseholdSummary | null; source: NotificationHistorySource; page: NotificationHistoryPage | null;
  online: boolean; loading: boolean; saving: boolean; pending: number; error: string | null; syncError: string | null; waitingForSettings: boolean;
}
/** Network work never holds the local save queue. Every response is fenced by
 * household, filter and mutation revision before it may replace visible history. */
export class NotificationHistoryController {
  private state: NotificationHistoryState = { household: null, source: "app", page: null, online: false, loading: false, saving: false, pending: 0, error: null, syncError: null, waitingForSettings: true }
  private listeners = new Set<() => void>()
  private generation = 0
  private revision = 0
  private context = ""
  private preferences: DeviceNotificationPreferences | null = null
  private deniedHouseholds = new Set<string>()
  private blockedSyncHouseholds = new Set<string>()
  private syncBlocked = false
  private globalAccessDenied = false
  private settingsPending = false
  private stopped = false
  private active = false
  private visible = false
  private needsRead = false
  private running: Promise<void> | null = null
  private localTail: Promise<void> = Promise.resolve()
  private saving = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly store: NotificationHistoryStore, private readonly identity: Omit<NotificationHistoryScope, "householdId">,
    private readonly api: HistoryApi, private readonly allowed: (householdId: string) => boolean, private readonly uuid: () => string,
    private readonly refreshAccess: () => Promise<void>, private readonly now: () => number = Date.now,
    private readonly canSyncHousehold: (householdId: string) => boolean = allowed) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<NotificationHistoryState>) { if (!this.stopped) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()) } }
  private current(generation: number, householdId: string) { return !this.stopped && generation === this.generation && this.state.household?.id === householdId && this.allowed(householdId) }
  observe(household: HouseholdSummary | null, preferences: DeviceNotificationPreferences | null, settingsPending: boolean) {
    this.preferences = preferences; this.settingsPending = settingsPending
    const context = household && (this.state.source === "web" || preferences)
      ? notificationHistoryFilterKey(household.role, preferences ? notificationHistorySelections(household.role, preferences) : [], this.state.source) : ""
    const waitingForSettings = this.state.source === "app" && (!preferences || settingsPending)
    if (household?.id === this.state.household?.id && context === this.context) {
      const ready = this.state.waitingForSettings && !waitingForSettings
      this.update({ household, waitingForSettings }); if (ready) { this.needsRead = true; this.wake() }; return
    }
    this.generation++; this.context = context; clearTimeout(this.timer)
    this.update({ household, page: null, loading: false, error: this.globalAccessDenied ? this.state.error : null, waitingForSettings })
    this.needsRead = true
    const generation = this.generation
    void this.readLocal().catch(error => { if (household && this.current(generation, household.id)) this.report(error) }); this.wake()
  }
  selectSource(source: NotificationHistorySource) {
    if (source === this.state.source) return
    this.generation++; this.context = ""; this.update({ source, page: null })
    this.observe(this.state.household, this.preferences, this.settingsPending)
  }
  private report(error: unknown) { this.update({ error: error instanceof Error ? error.message : "Unable to load notifications." }) }
  private async readLocal() {
    const householdId = this.state.household?.id, generation = this.generation, revision = this.revision, context = this.context, source = this.state.source
    if (!householdId || !context || !this.current(generation, householdId)) return
    const [page, pending] = await Promise.all([this.globalAccessDenied || this.deniedHouseholds.has(householdId) ? null : this.store.read({ ...this.identity, householdId }, source, context), this.store.pending(this.identity.accountId)])
    if (this.current(generation, householdId) && revision === this.revision) this.update({ page, pending: pending.length })
  }
  private resetSyncBlocks() { this.syncBlocked = false; this.blockedSyncHouseholds.clear() }
  private async blockAccess(householdId: string, error: unknown) {
    if (!(error instanceof TransportError) || ![401, 403, 423].includes(error.status)) return false
    if (error.status === 403 && error.code === "history_household_unavailable") {
      this.blockedSyncHouseholds.add(householdId); this.deniedHouseholds.add(householdId)
      if (this.state.household?.id === householdId) { this.revision++; this.update({ page: null }) }
      await this.store.forgetCache(this.identity.accountId, householdId).catch(() => undefined)
    } else {
      // Session, installation and kiosk failures affect every household on this
      // account. Keep memory hidden even when storage cleanup fails.
      this.syncBlocked = true; this.globalAccessDenied = true; this.revision++; this.update({ page: null })
      await this.store.forgetAccountCache(this.identity.accountId).catch(() => undefined)
    }
    return true
  }
  private maySync(householdId: string) { return !this.stopped && this.active && this.state.online && !this.syncBlocked && this.canSyncHousehold(householdId) }
  setConnectivity(online: boolean) { if (online === this.state.online) return; this.update({ online }); if (online) { this.resetSyncBlocks(); this.needsRead = true; this.wake() } else clearTimeout(this.timer) }
  setActive(active: boolean) { const resumed = active && !this.active; this.active = active; if (active) { if (resumed) this.resetSyncBlocks(); this.needsRead = true; this.wake() } else clearTimeout(this.timer) }
  setVisible(visible: boolean) { this.visible = visible; if (visible) { this.needsRead = true; this.wake() } }
  private wake(delay = 0) {
    clearTimeout(this.timer)
    if (this.stopped || !this.active || !this.state.online || this.running) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(false) }, delay)
  }
  async refresh() { this.resetSyncBlocks(); this.needsRead = true; return this.run(false) }
  async loadMore() { if (!this.running && this.state.page?.nextCursor && this.state.online) return this.run(true) }
  private run(append: boolean): Promise<void> {
    if (this.running) return this.running
    const householdId = this.state.household?.id, generation = this.generation
    if (!this.active || this.stopped) return Promise.resolve()
    clearTimeout(this.timer)
    let retry: number | null = null, denied = false, syncError: string | null = null
    this.running = (async () => {
      await this.localTail
      if (this.stopped || !this.active) return
      await this.readLocal().catch(error => { if (householdId && this.current(generation, householdId)) this.report(error) })
      if (!this.state.online || this.stopped) return
      const delayed = new Set<string>()
      for (const operation of await this.store.pending(this.identity.accountId)) {
        const target = operation.action.householdId
        if (!this.maySync(target) || this.blockedSyncHouseholds.has(target) || delayed.has(target)) continue
        const remaining = remainingRetry(operation.nextAttemptMs, this.now())
        if (remaining) { delayed.add(target); continue }
        try {
          if (!await this.store.isPending({ ...this.identity, householdId: target }, operation.id) || !this.maySync(target)) continue
          await this.api.updateNotificationHistory(operation.action)
          if (this.stopped) return
          await this.store.acknowledge(this.identity.accountId, operation.id)
        } catch (error) {
          if (this.stopped) return
          syncError = error instanceof Error ? error.message : "Saved notification changes could not sync."
          delayed.add(target)
          try { await this.store.fail(this.identity.accountId, operation, this.now()) }
          catch { this.syncBlocked = true }
          await this.blockAccess(target, error)
        }
      }
      if (!householdId || !this.current(generation, householdId)) return
      await this.readLocal()
      if (!this.visible || this.syncBlocked || this.state.waitingForSettings || !this.context || (!this.needsRead && !append)) return
      this.needsRead = false
      const context = this.context, source = this.state.source, revision = this.revision, cursor = append ? this.state.page?.nextCursor : null
      this.update({ loading: true, error: null })
      const page = await this.api.notificationHistory(householdId, source, cursor ?? undefined)
      const current = () => this.current(generation, householdId) && revision === this.revision
      if (!current()) { if (this.current(generation, householdId)) this.needsRead = true; return }
      await this.store.cache({ ...this.identity, householdId }, page, context, Boolean(cursor), current)
      if (current()) { this.globalAccessDenied = false; this.deniedHouseholds.delete(householdId); await this.readLocal() } else if (this.current(generation, householdId)) this.needsRead = true
    })().catch(async error => {
      if (!householdId || !this.current(generation, householdId)) return
      denied = await this.blockAccess(householdId, error)
      if (!this.current(generation, householdId)) return
      this.needsRead = append && error instanceof TransportError && error.status === 409
      this.report(error)
    }).finally(async () => {
      const pending = await this.store.pending(this.identity.accountId).catch(error => {
        this.syncBlocked = true
        if (householdId && this.current(generation, householdId)) this.report(error)
        return null
      })
      this.running = null
      if (this.stopped) return
      this.update({ loading: false, ...(pending ? { pending: pending.length, syncError: pending.length ? syncError ?? this.state.syncError : null } : {}) })
      if (pending) {
        const firstByHousehold = new Map<string, typeof pending[number]>()
        for (const operation of pending) if (!firstByHousehold.has(operation.action.householdId)) firstByHousehold.set(operation.action.householdId, operation)
        for (const [target, operation] of firstByHousehold) if (this.maySync(target) && !this.blockedSyncHouseholds.has(target)) {
          const delay = Math.max(100, remainingRetry(operation.nextAttemptMs, this.now()))
          retry = retry === null ? delay : Math.min(retry, delay)
        }
      }
      const needsView = this.needsRead && this.visible && !this.state.waitingForSettings && this.state.household && this.allowed(this.state.household.id)
        && !this.syncBlocked && (!denied || generation !== this.generation)
      if (retry !== null || needsView) this.wake(retry ?? 0)
    })
    return this.running
  }
  async change(action: "read" | "dismiss" | "readAll" | "dismissAll", notificationId?: string) {
    const householdId = this.state.household?.id, generation = this.generation, page = this.state.page, context = this.context, source = this.state.source
    if (!householdId || !page || !this.current(generation, householdId)) throw new Error("Load notifications for this household first.")
    const operation: NotificationHistoryAction = action === "readAll" || action === "dismissAll" ? { householdId, source, action, through: page.through }
      : { householdId, source, action, notificationId: notificationId ?? "" }
    if ("notificationId" in operation && !page.items.some(item => item.id === operation.notificationId)) throw new Error("That notification is no longer available.")
    this.revision++; this.saving++; this.update({ saving: true, error: null })
    const saved = this.localTail.then(() => this.store.enqueue({ ...this.identity, householdId }, this.uuid(), operation, context, () => this.current(generation, householdId)))
    this.localTail = saved.catch(() => undefined)
    try { await saved; if (this.current(generation, householdId)) await this.readLocal() }
    catch (error) { if (this.current(generation, householdId)) this.report(error); throw error }
    finally { this.saving--; this.update({ saving: this.saving > 0 }); this.wake() }
  }
  async prepareOpen(notificationId: string): Promise<NotificationHistoryItem> {
    const householdId = this.state.household?.id, generation = this.generation
    if (!householdId || !this.state.online) throw new Error("Connect to check access before opening this notification.")
    await this.refreshAccess()
    if (!this.active || !this.current(generation, householdId)) throw new Error("Household access changed. Open its current notifications.")
    const item = this.state.page?.items.find(entry => entry.id === notificationId)
    if (!item) throw new Error("That notification is no longer available.")
    await this.change("read", item.id)
    if (!this.active || !this.current(generation, householdId)) throw new Error("The household changed. Try again.")
    return item
  }
  stop() { this.stopped = true; this.generation++; clearTimeout(this.timer); this.listeners.clear() }
}
