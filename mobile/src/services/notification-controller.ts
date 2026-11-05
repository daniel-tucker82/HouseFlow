import type { BoardState } from "./board-controller"
import { defaultNotificationPreferences, inQuietHours, notificationCatalog, type DeviceNotificationPreferences, type MobileNotificationKind } from "../../../shared/mobile/notification-catalog"
import { notificationMemberSelection, type NativeNotificationPayload } from "../../../shared/mobile/notification-payload"
import { parseNotificationPreferences, restrictNotificationPreferences, type NativeNotificationDevice, type NotificationSettingsOperation, type NotificationSettingsSnapshot } from "../../../shared/mobile/notification-settings"
import type { HouseholdMember, HouseholdSummary } from "../../../shared/mobile/contracts"
import type { NotificationDevice, NotificationPermissionState } from "./notification-device"
import type { NotificationServerSnapshot, NotificationSettingRow, NotificationStore, RegistrationIntent } from "../storage/notification-store"
import { TransportError } from "../storage/sync-engine"

interface NotificationsApi {
  notificationSettings(householdId?: string): Promise<{ device: NativeNotificationDevice; settings: NotificationSettingsSnapshot | null }>
  saveNotificationSettings(operation: NotificationSettingsOperation): Promise<NotificationServerSnapshot>
}
export interface NotificationState extends NotificationPermissionState {
  household: HouseholdSummary | null; members: HouseholdMember[]; preferences: DeviceNotificationPreferences | null;
  device: NativeNotificationDevice | null; pending: NotificationSettingRow[]; checkingPermission: boolean; syncing: boolean; error: string | null; permissionError: string | null;
}
function eligible(rows: NotificationSettingRow[]) {
  const registered = rows.some(row => row.scope === "device" && row.server && row.server.revision !== "0")
  return rows.filter(row => row.desired && row.state === "pending" && (row.scope === "device" || registered))
}
export class NotificationController {
  private state: NotificationState = { household: null, members: [], preferences: null, device: null, pending: [], permission: "undetermined", canAskAgain: true, checkingPermission: false, syncing: false, error: null, permissionError: null }
  private listeners = new Set<() => void>()
  private stopped = false
  private active = true
  private online = false
  private started = false
  private readRevision = 0
  private refreshRevision = 0
  private editSequence = 0
  private optimistic = new Map<string, { id: number; preferences: DeviceNotificationPreferences }>()
  private running: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private tokenSubscription: (() => void) | undefined
  private households: HouseholdSummary[] = []
  private rows: NotificationSettingRow[] = []
  private selectionHashes = new Map<string, string>()
  private hashing = new Set<string>()
  constructor(private readonly store: NotificationStore, private readonly accountId: string, private readonly api: NotificationsApi,
    private readonly native: NotificationDevice, private readonly uuid: () => string, private readonly now: () => number = Date.now,
    private readonly hashSelection?: (selection: string) => Promise<string>) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<NotificationState>) { if (!this.stopped) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()) } }
  private report(error: unknown) { this.update({ error: error instanceof Error ? error.message : "Unable to update notifications." }) }
  async start() {
    await this.readLocal()
    if (this.stopped) return
    try { this.tokenSubscription = this.native.listenForTokenChange(() => { void this.refreshDevice() }) }
    catch (error) { this.report(error) }
    this.started = true
    await this.refreshDevice()
    this.wake()
  }
  observe(board: BoardState) {
    this.households = board.households
    const household = board.board?.household ?? null, switched = household?.id !== this.state.household?.id
    this.update({ household, members: board.board?.members ?? [], ...(switched ? { preferences: null, error: null } : {}) })
    if (switched) { this.readRevision++; this.refreshRevision++; void this.readLocal().catch(error => this.report(error)); if (this.started) void this.refresh() }
    else if (household) void this.readLocal().catch(error => this.report(error))
  }
  setConnectivity(online: boolean) {
    const reconnected = online && !this.online; this.online = online
    if (!online) clearTimeout(this.retryTimer)
    if (reconnected && this.started) { void this.refresh(); void this.refreshDevice(); this.wake() }
  }
  setActive(active: boolean) {
    this.active = active
    if (!active) clearTimeout(this.retryTimer)
    else if (this.started) { void this.refreshDevice(); void this.refresh(); this.wake() }
  }
  private async readLocal() {
    const revision = ++this.readRevision, household = this.state.household
    const rows = await this.store.all(this.accountId)
    if (this.stopped || revision !== this.readRevision || household?.id !== this.state.household?.id) return
    this.rows = rows
    this.prepareSelectionHashes()
    const row = rows.find(row => row.scope === household?.id)
    const fallback = defaultNotificationPreferences(this.accountId, Intl.DateTimeFormat().resolvedOptions().timeZone)
    fallback.enabled = ["granted", "provisional"].includes(this.state.permission)
    const saved = row?.server as NotificationSettingsSnapshot | undefined
    const selected = household ? this.optimistic.get(household.id)?.preferences ?? (row?.desired as DeviceNotificationPreferences | undefined) ?? (saved?.configured ? saved.preferences : fallback) : null
    this.update({ device: rows.find(row => row.scope === "device")?.server as NativeNotificationDevice ?? null, pending: rows.filter(row => row.desired !== null),
      preferences: selected && household ? restrictNotificationPreferences(selected, this.accountId, household.role, this.state.members.map(member => member.id)) : null })
  }
  private presentationPreferences(household: HouseholdSummary) {
    const row = this.rows.find(row => row.scope === household.id), saved = row?.server as NotificationSettingsSnapshot | undefined
    const preferences = this.optimistic.get(household.id)?.preferences ?? row?.desired as DeviceNotificationPreferences | undefined
      ?? (saved?.configured ? saved.preferences : defaultNotificationPreferences(this.accountId, household.timezone))
    return household.id === this.state.household?.id
      ? restrictNotificationPreferences(preferences, this.accountId, household.role, this.state.members.map(member => member.id)) : preferences
  }
  private prepareSelectionHashes() {
    if (!this.hashSelection || this.stopped) return
    for (const household of this.households) {
      const preferences = this.presentationPreferences(household)
      for (const kind of Object.keys(notificationCatalog) as MobileNotificationKind[]) {
        if (notificationCatalog[kind].scope !== "member" || !preferences.categories[kind]?.enabled) continue
        const key = notificationMemberSelection(preferences, kind)
        if (this.selectionHashes.has(key) || this.hashing.has(key)) continue
        this.hashing.add(key)
        void this.hashSelection(key).then(hash => {
          if (this.stopped) return
          // Keep this cache bounded during long shared-tablet sessions.
          if (this.selectionHashes.size >= 256) this.selectionHashes.delete(this.selectionHashes.keys().next().value!)
          this.selectionHashes.set(key, hash)
        }).catch(() => {}).finally(() => this.hashing.delete(key))
      }
    }
  }
  /** Synchronous and memory-only: never await storage, hashing or HTTP in the OS handler. */
  canPresent(payload: NativeNotificationPayload) {
    const household = this.households.find(item => item.id === payload.householdId)
    if (this.stopped || !this.started || !this.active || !household || payload.accountId !== this.accountId
      || !["granted", "provisional"].includes(this.state.permission)) return false
    try {
      const category = notificationCatalog[payload.kind], preferences = this.presentationPreferences(household), selection = preferences.categories[payload.kind]
      if (!preferences.enabled || !selection?.enabled || (payload.hasDetails && !preferences.showDetails) || inQuietHours(preferences, new Date(this.now()))) return false
      if (category.managementOnly && household.role !== "manager") return false
      if (category.scope === "household") return household.role !== "member"
      if (household.role === "member" && (selection.memberIds.length !== 1 || selection.memberIds[0] !== this.accountId)) return false
      return selection.memberIds.length > 0 && this.selectionHashes.get(notificationMemberSelection(preferences, payload.kind)) === payload.memberSelectionHash
    } catch { return false }
  }
  private async fetchScope(scope: string) {
    const response = await this.api.notificationSettings(scope === "device" ? undefined : scope)
    if (this.stopped) return null
    await this.store.cache(this.accountId, response.device)
    if (response.settings) await this.store.cache(this.accountId, response.settings)
    return scope === "device" ? response.device : response.settings
  }
  async refresh() {
    if (!this.online || !this.active || this.stopped) return
    const revision = ++this.refreshRevision, scope = this.state.household?.id ?? "device"
    try { await this.fetchScope(scope); if (revision === this.refreshRevision) { await this.readLocal(); this.update({ error: null }) } }
    catch (error) { if (revision === this.refreshRevision) this.report(error) }
  }
  async refreshDevice(requestPermission = false) {
    if (this.stopped || !this.active || this.state.checkingPermission) return
    this.update({ checkingPermission: true, permissionError: null })
    try {
      const permission = requestPermission ? await this.native.requestPermission() : await this.native.inspect()
      if (this.stopped) return
      this.update(permission)
      const previous = await this.store.get(this.accountId, "device")
      let token: string | null = null, tokenFailed = false
      if (["granted", "provisional"].includes(permission.permission)) {
        if (this.online) {
          try { token = await this.native.token() }
          catch (error) { tokenFailed = true; this.update({ permissionError: error instanceof Error ? error.message : "Waiting to register notifications. Try again when connected." }) }
        } else tokenFailed = true
      }
      if (this.stopped) return
      // A transient token fetch failure must not disable a working registration.
      const hasRegistration = (previous.server as NativeNotificationDevice | null)?.hasToken
        || (previous.desired as RegistrationIntent | null)?.token
        || (previous.request?.action === "registerDevice" && previous.request.token)
      if (!tokenFailed || !hasRegistration) {
        await this.store.save(this.accountId, "device", { ...this.native.details(), permission: permission.permission, token })
      }
      await this.readLocal()
    } catch (error) { this.update({ permissionError: error instanceof Error ? error.message : "Unable to read notification permission." }) }
    finally { this.update({ checkingPermission: false }); this.wake() }
  }
  channelRestrictions() { return this.native.channelRestrictions() }
  openSystemSettings(kind?: MobileNotificationKind) { return this.native.openSettings(kind) }
  async changePreferences(update: (preferences: DeviceNotificationPreferences) => DeviceNotificationPreferences) {
    const household = this.state.household, previous = this.state.preferences
    if (!household || !previous || this.stopped) return
    const preferences = parseNotificationPreferences(update(previous)), id = ++this.editSequence
    this.optimistic.set(household.id, { id, preferences }); this.update({ preferences, error: null })
    this.prepareSelectionHashes()
    try { await this.store.save(this.accountId, household.id, preferences) }
    catch (error) { this.report(new Error(`This notification change could not be saved on this device. ${error instanceof Error ? error.message : "Please try again."}`)); throw error }
    finally { if (this.optimistic.get(household.id)?.id === id) this.optimistic.delete(household.id); await this.readLocal(); this.wake() }
  }
  async review(scope: string, discard = false) {
    if (!this.online) throw new Error("Connect to review the latest notification settings.")
    const fresh = await this.fetchScope(scope)
    if (!fresh || this.stopped) return
    if (discard) await this.store.discard(this.accountId, scope, fresh)
    else {
      if (scope === this.state.household?.id && this.state.preferences) await this.store.save(this.accountId, scope, this.state.preferences)
      await this.store.retry(this.accountId, scope, fresh)
    }
    await this.readLocal(); this.wake()
  }
  private wake() {
    clearTimeout(this.retryTimer)
    if (!this.started || !this.online || !this.active || this.stopped || this.running) return
    this.running = this.flush().catch(error => this.report(error)).finally(async () => {
      this.running = null
      await this.readLocal().catch(error => this.report(error))
      this.update({ syncing: false })
      if (!this.online || !this.active || this.stopped) return
      try {
        const ready = eligible(await this.store.all(this.accountId))
        if (!this.online || !this.active || this.stopped) return
        if (ready.length) this.retryTimer = setTimeout(() => this.wake(), Math.max(50, Math.min(...ready.map(row => row.nextAttemptMs)) - this.now()))
      } catch (error) { this.report(error) }
    })
  }
  private async flush() {
    this.update({ syncing: true })
    for (let count = 0; count < 20; count++) {
      if (!this.online || !this.active || this.stopped) return
      const rows = await this.store.all(this.accountId)
      const row = eligible(rows).find(row => row.nextAttemptMs <= this.now())
      if (!row) return
      let operation = row.request
      try {
        if (!operation) { await this.fetchScope(row.scope); if (this.stopped || !this.online || !this.active) return; operation = await this.store.prepare(this.accountId, row.scope, this.uuid()) }
        if (!operation) continue
        const response = await this.api.saveNotificationSettings(operation)
        if (this.stopped) return
        await this.store.acknowledge(this.accountId, row.scope, operation.operationId, response)
        // A receipt may predate later changes; refresh after acknowledgement, never rewrite them.
        await this.fetchScope(row.scope)
        await this.readLocal()
      } catch (error) {
        if (this.stopped) return
        const rejected = error instanceof TransportError && [400, 403, 404, 409, 410, 422].includes(error.status)
        await this.store.fail(this.accountId, row.scope, operation?.operationId ?? null, error instanceof Error ? error.message : "Waiting for a connection", rejected, this.now())
        this.report(error)
        return
      }
    }
  }
  stop() { this.stopped = true; this.readRevision++; this.refreshRevision++; clearTimeout(this.retryTimer); this.tokenSubscription?.(); this.listeners.clear() }
}
