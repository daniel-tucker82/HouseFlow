import type { BoardSnapshot, CompletionChange, CompletionResult, HouseholdSummary } from "../../../shared/mobile/contracts"
import { TransportError, type SyncTransport } from "../storage/sync-engine"
import type { PlannerEdit, PlannerSnapshot } from "../../../shared/mobile/planner"
import type { RunPage, RunSnapshot, RunView } from "../../../shared/mobile/runs"
import type { NativeNotificationDevice, NotificationSettingsOperation, NotificationSettingsSnapshot } from "../../../shared/mobile/notification-settings"
import type { NotificationHistoryAction, NotificationHistoryPage, NotificationHistoryScope, NotificationHistorySource } from "../../../shared/mobile/notification-history"
import type { AccountDeletionReview } from "../../../shared/mobile/account-deletion"
import { parseAccountDeletionReview } from "./account-deletion-review"
import { parseNativeKioskSession, type NativeKioskOperation, type NativeKioskResult } from "../../../shared/mobile/kiosk"
import { isWebBillingCancellationUrl, type NativeBillingAction, type NativeBillingScope, type NativeBillingSetup, type NativeBillingStatus, type NativeBillingStore, type WebBillingCancellation } from "../../../shared/mobile/billing"

export interface BootstrapResult { accountId: string; households: HouseholdSummary[]; board: BoardSnapshot | null }

/** All requests are bound to the account which opened this runtime. */
export class MobileApi implements SyncTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly accountId: string,
    private readonly deviceId: string,
    private readonly token: () => Promise<string | null>,
    private readonly installationSecret?: () => Promise<string>,
    private readonly sessionId?: string,
  ) {
    const url = new URL(baseUrl)
    if (url.protocol !== "https:" && !__DEV__) throw new Error("Cyntch requires a secure connection")
  }

  async request<T>(path: string, body?: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<T> {
    const token = await this.token()
    if (!token) throw new TransportError("Sign in again to sync your saved changes.", 401)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 25_000)
    try {
      const response = await fetch(new URL(path, this.baseUrl).toString(), {
        method: body ? "POST" : "GET", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          "X-Task-Save-User": this.accountId, "X-Cyntch-Device": this.deviceId, ...(this.sessionId ? { "X-Cyntch-Session": this.sessionId } : {}), ...extraHeaders },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new TransportError(data?.error ?? "Cyntch could not sync right now. Your saved changes will retry.", response.status, typeof data?.code === "string" ? data.code : undefined)
      if (!data || typeof data !== "object") throw new Error("Cyntch returned an unexpected response")
      return data as T
    } finally { clearTimeout(timeout) }
  }

  async bootstrap(householdId?: string): Promise<BootstrapResult> {
    const data = await this.request<BootstrapResult>(`/api/mobile/bootstrap${householdId ? `?householdId=${encodeURIComponent(householdId)}` : ""}`)
    if (data.accountId !== this.accountId) throw new Error("Your account changed. Please sign in again.")
    return data
  }

  async serverTime() { return (await this.request<{ serverTimeMs: number }>("/api/mobile/time")).serverTimeMs }

  async accountDeletionReview(): Promise<AccountDeletionReview> {
    const review = await this.request<AccountDeletionReview>("/api/mobile/account-deletion", undefined, await this.notificationHeaders())
    return parseAccountDeletionReview(review,{accountId:this.accountId,sessionId:this.sessionId ?? "",deviceId:this.deviceId})
  }

  private validateBilling<T extends NativeBillingScope>(result: T, householdId: string): T {
    if (result.accountId !== this.accountId || result.sessionId !== this.sessionId || result.deviceId !== this.deviceId || result.householdId !== householdId) {
      throw new Error("This billing reply belongs to a different account, household or sign-in. Refresh before continuing.")
    }
    return result
  }
  async billingStatus(householdId: string) {
    return this.validateBilling(await this.request<NativeBillingStatus>(`/api/mobile/billing?householdId=${encodeURIComponent(householdId)}`), householdId)
  }
  async prepareBilling(householdId: string, store: NativeBillingStore) {
    const result = this.validateBilling(await this.request<NativeBillingSetup>("/api/mobile/billing", { action: "prepare", householdId, store }), householdId)
    if (result.store !== store || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result.billingCustomerId) ||
      !(store === "app_store" ? /^appl_[a-zA-Z0-9]+$/ : /^goog_[a-zA-Z0-9]+$/).test(result.publicSdkKey) ||
      !["production", "sandbox"].includes(result.environment) || !Array.isArray(result.products) || result.products.length !== 2 ||
      new Set(result.products.map(product => product.interval)).size !== 2 ||
      result.products.some(product => !["monthly", "yearly"].includes(product.interval) || typeof product.storeProductId !== "string" || !product.storeProductId.length)) {
      throw new Error("Cyntch returned an invalid store configuration.")
    }
    return result
  }
  async billingPurchase(action: Extract<NativeBillingAction, { action: "begin" | "cancel" }>) {
    const result = this.validateBilling(await this.request<NativeBillingScope & { operationId: string; expiresAt?: string }>("/api/mobile/billing", action), action.householdId)
    if (result.operationId !== action.operationId || (action.action === "begin" && (!result.expiresAt || !Number.isFinite(Date.parse(result.expiresAt))))) {
      throw new Error("The purchase reply did not match this attempt. Refresh billing before continuing.")
    }
    return result
  }
  async verifyBilling(householdId: string) {
    return this.validateBilling(await this.request<NativeBillingStatus>("/api/mobile/billing", { action: "verify", householdId }), householdId)
  }
  async webBillingCancellation(householdId: string) {
    const result = this.validateBilling(await this.request<WebBillingCancellation>("/api/mobile/billing", { action: "webCancellation", householdId }),householdId)
    if (result.provider !== "stripe" || !isWebBillingCancellationUrl(result.url)) throw new Error("Cyntch returned an invalid cancellation link.")
    return result
  }

  async kioskSettings() {
    const result = await this.request<NativeKioskResult>("/api/mobile/kiosk", undefined, await this.notificationHeaders())
    return this.validateKiosk(result)
  }
  async saveKiosk(operation: NativeKioskOperation) {
    const result = this.validateKiosk(await this.request<NativeKioskResult>("/api/mobile/kiosk", { ...operation }, await this.notificationHeaders()))
    if (operation.action === "recover") {
      const receipt = result.recovery
      if (!receipt || receipt.id !== operation.id || receipt.accountId !== this.accountId || receipt.deviceId !== this.deviceId || receipt.sessionId !== operation.previousSessionId) throw new Error("The recovery reply did not match this device lock.")
    } else if (operation.action === "unlock" && result.cancelledActivation) {
      const receipt = result.cancelledActivation
      if (receipt.id !== operation.id || receipt.accountId !== this.accountId || receipt.deviceId !== this.deviceId || receipt.sessionId !== this.sessionId) throw new Error("The cancellation reply did not match this device lock.")
    } else if (!result.kiosk || result.kiosk.id !== operation.id || result.kiosk.sessionId !== this.sessionId) throw new Error("The kiosk reply did not match this sign-in.")
    return result
  }
  private validateKiosk(result: NativeKioskResult) {
    if (result.kiosk !== null) {
      const kiosk = parseNativeKioskSession(result.kiosk)
      if (kiosk.accountId !== this.accountId || kiosk.deviceId !== this.deviceId) throw new Error("The kiosk reply did not match this account and device.")
      return { ...result, kiosk }
    }
    return result
  }

  private async notificationHeaders() {
    if (!this.installationSecret || !this.sessionId) throw new Error("This device's secure registration is not available.")
    return { "X-Cyntch-Installation": await this.installationSecret(), "X-Cyntch-Session": this.sessionId }
  }
  private validateNotificationHistory<T extends NotificationHistoryScope & {source:NotificationHistorySource}>(result:T,householdId:string,source:NotificationHistorySource){
    if(result.accountId!==this.accountId||result.sessionId!==this.sessionId||result.deviceId!==this.deviceId||result.householdId!==householdId||result.source!==source)throw new Error("Notification history belongs to a different account or device. Refresh before continuing.")
    return result
  }
  async notificationHistory(householdId:string,source:NotificationHistorySource,cursor?:string){
    return this.validateNotificationHistory(await this.request<NotificationHistoryPage>(`/api/mobile/notification-history?${new URLSearchParams({householdId,source,...(cursor?{cursor}:{})})}`,undefined,await this.notificationHeaders()),householdId,source)
  }
  async updateNotificationHistory(action:NotificationHistoryAction){
    return this.validateNotificationHistory(await this.request<NotificationHistoryScope & {source:NotificationHistorySource;ok:true}>("/api/mobile/notification-history",{...action},await this.notificationHeaders()),action.householdId,action.source)
  }
  async notificationSettings(householdId?: string) {
    const result = await this.request<{ device: NativeNotificationDevice; settings: NotificationSettingsSnapshot | null }>(
      `/api/mobile/notifications${householdId ? `?householdId=${encodeURIComponent(householdId)}` : ""}`, undefined, await this.notificationHeaders())
    if (result.device?.accountId !== this.accountId || result.device.deviceId !== this.deviceId || (householdId && (result.settings?.householdId !== householdId || result.settings.accountId !== this.accountId || result.settings.deviceId !== this.deviceId))) throw new Error("The notification settings did not match your account and device.")
    return result
  }
  async saveNotificationSettings(operation: NotificationSettingsOperation) {
    const result = await this.request<{ device?: NativeNotificationDevice; settings?: NotificationSettingsSnapshot; replayed: boolean }>("/api/mobile/notifications", { ...operation }, await this.notificationHeaders())
    const saved = operation.action === "registerDevice" ? result.device : result.settings
    if (!saved || saved.accountId !== this.accountId || saved.deviceId !== this.deviceId || (operation.action === "savePreferences" && result.settings?.householdId !== operation.householdId)) throw new Error("The notification save did not match your account and device.")
    return saved
  }

  async runs(householdId: string, view: RunView, cursor?: string): Promise<RunPage> {
    const query = new URLSearchParams({ householdId, view }); if (cursor) query.set("cursor", cursor)
    const page = await this.request<RunPage>(`/api/mobile/runs?${query}`)
    if (page.householdId !== householdId || page.view !== view) throw new Error("The run list did not match your household.")
    return page
  }
  async run(householdId: string, occurrenceId: string): Promise<RunSnapshot> {
    const snapshot = await this.request<RunSnapshot>(`/api/mobile/runs?${new URLSearchParams({ householdId, occurrenceId })}`)
    if (snapshot.household?.id !== householdId || snapshot.run?.id !== occurrenceId) throw new Error("The run did not match your household.")
    return snapshot
  }

  async renameRun(householdId: string, occurrenceId: string, title: string): Promise<string> {
    const result = await this.request<{ occurrence: { id: string; household_id: string; title: string } }>("/api/leader/flow",
      { action: "renameTaskBoard", householdId, occurrenceId, title })
    if (result.occurrence?.id !== occurrenceId || result.occurrence.household_id !== householdId || result.occurrence.title !== title.trim()) {
      throw new Error("The saved name did not match this run. Refresh before trying again.")
    }
    return result.occurrence.title
  }
  async deleteRun(householdId: string, occurrenceId: string): Promise<void> {
    const result = await this.request<{ ok: boolean }>("/api/leader/flow", { action: "deleteOccurrence", householdId, occurrenceId })
    if (result.ok !== true) throw new Error("Deletion was not confirmed. Refresh this run before trying again.")
  }

  async planner(householdId: string): Promise<PlannerSnapshot> {
    const data = await this.request<PlannerSnapshot>(`/api/leader/flow?householdId=${encodeURIComponent(householdId)}`)
    return { householdId, routines: data.routines, tasks: data.tasks, dependencies: data.dependencies,
      taskAssignees: data.taskAssignees, members: data.members, occurrences: data.occurrences }
  }

  savePlannerEdit(edit: PlannerEdit) {
    if (edit.accountId !== this.accountId) throw new Error("Your account changed. Sign in again to save this edit.")
    return this.request("/api/leader/flow", { ...edit.draft, action: "updateTask", householdId: edit.householdId,
      saveStreamId: edit.deviceId, saveRevision: edit.revision, saveId: edit.id })
  }

  send(change: CompletionChange) {
    if (change.accountId !== this.accountId || change.correctedTimeMs === null) throw new Error("This change is not ready to sync")
    return this.request<CompletionResult>("/api/mobile/completions", {
      action: "setOccurrenceTaskCompleted", householdId: change.householdId, occurrenceId: change.occurrenceId,
      taskId: change.taskId, actorMemberId: change.memberId, completed: change.completed,
      clientOperation: { id: change.id, deviceId: change.deviceId, sequence: change.sequence, correctedTimeMs: change.correctedTimeMs },
    })
  }
}
