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
  online: boolean; loading: boolean; saving: boolean; pending: number; error: string | null; waitingForSettings: boolean;
}
/** Network work never holds the local save queue. Every response is fenced by
 * household, filter and mutation revision before it may replace visible history. */
export class NotificationHistoryController {
  private state: NotificationHistoryState = { household: null, source: "app", page: null, online: false, loading: false, saving: false, pending: 0, error: null, waitingForSettings: true }
  private listeners = new Set<() => void>()
  private generation = 0
  private revision = 0
  private context = ""
  private preferences: DeviceNotificationPreferences | null = null
  private deniedHouseholds = new Set<string>()
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
    private readonly refreshAccess: () => Promise<void>, private readonly now: () => number = Date.now) {}
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
    this.update({ household, page: null, pending: 0, loading: false, error: null, waitingForSettings })
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
    const [page, pending] = await Promise.all([this.deniedHouseholds.has(householdId) ? null : this.store.read({ ...this.identity, householdId }, source, context), this.store.pending(this.identity.accountId, householdId)])
    if (this.current(generation, householdId) && revision === this.revision) this.update({ page, pending: pending.length })
  }
  setConnectivity(online: boolean) { if (online === this.state.online) return; this.update({ online }); if (online) { this.needsRead = true; this.wake() } else clearTimeout(this.timer) }
  setActive(active: boolean) { this.active = active; if (active) { this.needsRead = true; this.wake() } else clearTimeout(this.timer) }
  setVisible(visible: boolean) { this.visible = visible; if (visible) { this.needsRead = true; this.wake() } }
  private wake(delay = 0) {
    clearTimeout(this.timer)
    const householdId = this.state.household?.id
    if (this.stopped || !this.active || !this.state.online || !householdId || !this.allowed(householdId) || this.running) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(false) }, delay)
  }
  async refresh() { this.needsRead = true; return this.run(false) }
  async loadMore() { if (!this.running && this.state.page?.nextCursor && this.state.online) return this.run(true) }
  private run(append: boolean): Promise<void> {
    if (this.running) return this.running
    const householdId = this.state.household?.id, generation = this.generation
    if (!householdId || !this.active || !this.current(generation, householdId)) return Promise.resolve()
    clearTimeout(this.timer)
    let retry: number | null = null, denied = false
    this.running = (async () => {
      await this.localTail
      if (!this.current(generation, householdId)) return
      await this.readLocal()
      if (!this.state.online || !this.current(generation, householdId)) return
      for (const operation of await this.store.pending(this.identity.accountId, householdId)) {
        if (!this.active || !this.state.online || !this.current(generation, householdId)) return
        const remaining = remainingRetry(operation.nextAttemptMs, this.now())
        if (remaining) { retry = remaining; break }
        try { await this.api.updateNotificationHistory(operation.action) }
        catch (error) { await this.store.fail(this.identity.accountId, operation, this.now()); throw error }
        if (!this.current(generation, householdId)) return
        await this.store.acknowledge(this.identity.accountId, operation.id)
      }
      if (!this.current(generation, householdId)) return
      await this.readLocal()
      if (!this.visible || this.state.waitingForSettings || !this.context || (!this.needsRead && !append)) return
      this.needsRead = false
      const context = this.context, source = this.state.source, revision = this.revision, cursor = append ? this.state.page?.nextCursor : null
      this.update({ loading: true, error: null })
      const page = await this.api.notificationHistory(householdId, source, cursor ?? undefined)
      const current = () => this.current(generation, householdId) && revision === this.revision
      if (!current()) { if (this.current(generation, householdId)) this.needsRead = true; return }
      await this.store.cache({ ...this.identity, householdId }, page, context, Boolean(cursor), current)
      if (current()) { this.deniedHouseholds.delete(householdId); await this.readLocal() } else if (this.current(generation, householdId)) this.needsRead = true
    })().catch(async error => {
      if (!this.current(generation, householdId)) return
      denied = error instanceof TransportError && [401, 403, 423].includes(error.status)
      if (denied) {
        this.deniedHouseholds.add(householdId); this.revision++; this.update({ page: null })
        // Keep memory fenced even if disk cleanup fails; a fresh authorized
        // response is required before this controller can expose history again.
        await this.store.forgetCache(this.identity.accountId, householdId).catch(() => undefined)
      }
      if (!this.current(generation, householdId)) return
      if (append && error instanceof TransportError && error.status === 409) this.needsRead = true
      this.report(error)
    }).finally(async () => {
      this.running = null
      if (!this.current(generation, householdId)) { this.wake(); return }
      this.update({ loading: false })
      const pending = await this.store.pending(this.identity.accountId, householdId).catch(error => {
        if (this.current(generation, householdId)) this.report(error)
        return null
      })
      if (!pending || !this.current(generation, householdId)) return
      this.update({ pending: pending.length })
      if (denied) return
      if (pending.length) retry = Math.max(100, remainingRetry(pending[0].nextAttemptMs, this.now()))
      if (retry !== null || (this.needsRead && this.visible && !this.state.waitingForSettings)) this.wake(retry ?? 0)
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
