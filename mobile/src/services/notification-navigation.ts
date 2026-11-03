import { notificationCatalog } from "../../../shared/mobile/notification-catalog"
import type { NativeNotificationPayload } from "../../../shared/mobile/notification-payload"
import type { NotificationInbox } from "../storage/notification-inbox"
import type { NotificationSession } from "../storage/notification-session-store"
import type { BoardController } from "./board-controller"
import type { RunsController } from "./runs-controller"

export interface NotificationNavigation {
  ready(): boolean
  // Application restrictions (including kiosk mode) are rechecked after awaits.
  allowed(payload: NativeNotificationPayload): boolean
  navigate(route: "/runs" | "/household"): void
  failed(message: string, retry: () => void, dismiss: () => void): void
}
export class NotificationNavigationController {
  private stopped = false
  private active = true
  private running = false
  private attempted: string | null = null
  private revision = 0
  private requested = false
  constructor(private readonly inbox: NotificationInbox, private readonly session: NotificationSession,
    private readonly board: BoardController, private readonly runs: RunsController, private readonly navigation: NotificationNavigation) {}
  async capture(payload: NativeNotificationPayload) {
    this.revision++
    const saved = await this.inbox.capture(payload, this.session)
    if (saved) { this.attempted = null; this.wake() }
    return saved
  }
  setActive(active: boolean) { this.active = active; if (!active) { this.revision++; this.attempted = null } else this.wake() }
  wake() {
    if (this.running) { this.requested = true; return }
    if (this.stopped || !this.active || !this.navigation.ready() || this.board.getSnapshot().loading) return
    this.running = true
    void this.open().catch(error => {
      if (!this.stopped) this.navigation.failed(error instanceof Error ? error.message : "Unable to open this notification.", () => { this.attempted = null; this.wake() }, () => {})
    }).finally(() => { this.running = false; if (this.requested) { this.requested = false; this.wake() } })
  }
  private async open() {
    const payload = await this.inbox.pending(this.session)
    if (!payload || this.stopped || !this.active || payload.deliveryId === this.attempted) return
    this.attempted = payload.deliveryId
    const revision = this.revision
    const current = async () => {
      if (this.stopped || !this.active || revision !== this.revision) return false
      if (!this.navigation.allowed(payload)) { await this.inbox.acknowledge(payload); return false }
      const pending = await this.inbox.pending(this.session)
      if (this.stopped || !this.active || revision !== this.revision) return false
      if (!this.navigation.allowed(payload)) { await this.inbox.acknowledge(payload); return false }
      return pending?.deliveryId === payload.deliveryId
    }
    try {
      if (!await current()) return
      // Refresh current access online; cached access still supports offline use.
      if (this.board.getSnapshot().online) {
        await this.board.refresh()
        if (this.board.getSnapshot().error) throw new Error("Connect to refresh this household before opening the notification.")
      }
      if (!await current()) return
      const household = this.board.getSnapshot().households.find(item => item.id === payload.householdId)
      if (!household) throw new Error(this.board.getSnapshot().online ? "This household is no longer available to this account." : "Connect to load the household for this notification.")
      const category = notificationCatalog[payload.kind]
      if ((category.managementOnly && household.role !== "manager") || (category.scope === "household" && household.role === "member")) throw new Error("Your current household role cannot open this notification.")
      if (this.board.getSnapshot().board?.household.id !== household.id) await this.board.selectHousehold(household.id)
      if (!await current()) return
      if (this.board.getSnapshot().board?.household.id !== household.id) throw new Error("This household could not be opened. Try again when connected.")
      const role = this.board.getSnapshot().board!.household.role
      if ((category.managementOnly && role !== "manager") || (category.scope === "household" && role === "member")) throw new Error("Your current household role cannot open this notification.")
      if (payload.occurrenceId) {
        this.navigation.navigate("/runs")
        // openRun sets its loading state immediately; the screen's focus effect
        // fetches details if navigation has not focused it yet.
        void this.runs.openRun(payload.occurrenceId, payload.taskId).catch(() => {})
      } else {
        this.runs.closeRun()
        this.navigation.navigate("/household")
      }
      await this.inbox.acknowledge(payload)
    } catch (error) {
      if (!await current()) return
      this.navigation.failed(error instanceof Error ? error.message : "Unable to open this notification.",
        () => { if (!this.stopped) { this.attempted = null; this.wake() } },
        () => { void this.inbox.acknowledge(payload).catch(() => {}) })
    }
  }
  stop() { this.stopped = true; this.revision++ }
}
