import type { DeviceNotificationPreferences } from "../../../shared/mobile/notification-catalog"
import { parseNotificationPreferences, type NativeNotificationDevice, type NotificationSettingsSnapshot, type NotificationSettingsOperation, type RegisterNotificationDevice } from "../../../shared/mobile/notification-settings"
import { retryDelayMs } from "../../../shared/mobile/sync-policy"
import type { HouseholdSummary } from "../../../shared/mobile/contracts"
import type { LocalDatabase, SqlConnection } from "./local-store"

export type RegistrationIntent = Omit<RegisterNotificationDevice, "action" | "operationId" | "baseRevision">
export type NotificationServerSnapshot = NativeNotificationDevice | NotificationSettingsSnapshot
export interface NotificationSettingRow {
  scope: string; server: NotificationServerSnapshot | null; desired: RegistrationIntent | DeviceNotificationPreferences | null;
  request: NotificationSettingsOperation | null; editVersion: number; requestVersion: number;
  confirmedDesired: RegistrationIntent | DeviceNotificationPreferences | null;
  state: "pending" | "rejected"; attempts: number; nextAttemptMs: number; error: string | null;
}
interface StoredRow { scope: string; data: string }

/** One desired state per scope; an in-flight request is immutable until acknowledged. */
export class NotificationStore {
  constructor(private readonly database: LocalDatabase) {}
  async initialize() {
    await this.database.execAsync(`CREATE TABLE IF NOT EXISTS native_notification_settings (
      account_id TEXT NOT NULL, scope TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account_id,scope));`)
  }
  private empty(scope: string): NotificationSettingRow { return { scope, server: null, desired: null, request: null, confirmedDesired: null, editVersion: 0, requestVersion: 0, state: "pending", attempts: 0, nextAttemptMs: 0, error: null } }
  async get(accountId: string, scope: string, tx: SqlConnection = this.database) {
    const row = await tx.getFirstAsync<StoredRow>("SELECT scope,data FROM native_notification_settings WHERE account_id=? AND scope=?", accountId, scope)
    return row ? JSON.parse(row.data) as NotificationSettingRow : this.empty(scope)
  }
  async all(accountId: string, tx: SqlConnection = this.database) {
    return (await tx.getAllAsync<StoredRow>("SELECT scope,data FROM native_notification_settings WHERE account_id=? ORDER BY scope='device' DESC,scope", accountId)).map(row => JSON.parse(row.data) as NotificationSettingRow)
  }
  private async write(tx: SqlConnection, accountId: string, row: NotificationSettingRow) {
    await tx.runAsync("INSERT INTO native_notification_settings VALUES(?,?,?) ON CONFLICT(account_id,scope) DO UPDATE SET data=excluded.data", accountId, row.scope, JSON.stringify(row))
  }
  private async allowed(accountId: string, scope: string, tx: SqlConnection) {
    if (scope !== "device" && await tx.getFirstAsync("SELECT household_id FROM revoked_households WHERE account_id=? AND household_id=?", accountId, scope)) throw new Error("Access to this household has been removed.")
  }
  async reconcile(accountId: string, households: HouseholdSummary[], tx: SqlConnection) {
    const allowed = new Set(households.map(household => household.id))
    for (const row of await this.all(accountId, tx)) {
      if (row.scope === "device" || allowed.has(row.scope)) continue
      await tx.runAsync("INSERT OR IGNORE INTO revoked_households(account_id,household_id) VALUES(?,?)", accountId, row.scope)
      // The settings only contain selections; removed household caches must not retain them.
      await tx.runAsync("DELETE FROM native_notification_settings WHERE account_id=? AND scope=?", accountId, row.scope)
    }
  }
  async cache(accountId: string, snapshot: NotificationServerSnapshot) {
    if (snapshot.accountId !== accountId) throw new Error("The notification account changed.")
    const scope = "householdId" in snapshot ? snapshot.householdId : "device"
    await this.database.withExclusiveTransactionAsync(async tx => {
      await this.allowed(accountId, scope, tx)
      const row = await this.get(accountId, scope, tx)
      if (!row.server || BigInt(snapshot.revision) >= BigInt(row.server.revision)) await this.write(tx, accountId, { ...row, server: snapshot,
        confirmedDesired: "preferences" in snapshot ? snapshot.preferences : snapshot.revision === row.server?.revision ? row.confirmedDesired : null })
    })
  }
  async save(accountId: string, scope: string, desired: RegistrationIntent | DeviceNotificationPreferences) {
    if (scope !== "device") desired = parseNotificationPreferences(desired)
    else { const value = desired as RegistrationIntent; desired = { platform: value.platform, permission: value.permission, token: value.token, deviceName: value.deviceName, appVersion: value.appVersion } }
    await this.database.withExclusiveTransactionAsync(async tx => {
      await this.allowed(accountId, scope, tx)
      const row = await this.get(accountId, scope, tx)
      if (JSON.stringify(row.desired ?? row.confirmedDesired) === JSON.stringify(desired)) return
      await this.write(tx, accountId, { ...row, desired, editVersion: row.editVersion + 1 })
    })
  }
  async prepare(accountId: string, scope: string, operationId: string): Promise<NotificationSettingsOperation | null> {
    let prepared: NotificationSettingsOperation | null = null
    await this.database.withExclusiveTransactionAsync(async tx => {
      await this.allowed(accountId, scope, tx)
      const row = await this.get(accountId, scope, tx)
      if (!row.desired || row.state === "rejected") return
      if (row.request) { prepared = row.request; return }
      if (!row.server) throw new Error("Connect once to refresh notification settings before syncing this change.")
      prepared = scope === "device" ? { ...row.desired as RegistrationIntent, action: "registerDevice", operationId, baseRevision: row.server.revision }
        : { action: "savePreferences", operationId, baseRevision: row.server.revision, householdId: scope, preferences: row.desired as DeviceNotificationPreferences }
      await this.write(tx, accountId, { ...row, request: prepared, requestVersion: row.editVersion })
    })
    return prepared
  }
  async acknowledge(accountId: string, scope: string, operationId: string, snapshot: NotificationServerSnapshot) {
    if (snapshot.accountId !== accountId || ("householdId" in snapshot ? snapshot.householdId : "device") !== scope) throw new Error("The notification response did not match these settings.")
    await this.database.withExclusiveTransactionAsync(async tx => {
      const row = await this.get(accountId, scope, tx)
      if (row.request?.operationId !== operationId) return // Removed scope or a different request; no resurrection.
      const server = !row.server || BigInt(snapshot.revision) >= BigInt(row.server.revision) ? snapshot : row.server
      const { request } = row
      const confirmedDesired = request.action === "savePreferences" ? request.preferences : {
        platform: request.platform, permission: request.permission, token: request.token, deviceName: request.deviceName, appVersion: request.appVersion,
      }
      await this.write(tx, accountId, { ...row, server, request: null, desired: row.requestVersion === row.editVersion ? null : row.desired,
        confirmedDesired: server === snapshot ? confirmedDesired : "preferences" in server ? server.preferences : null,
        attempts: 0, nextAttemptMs: 0, state: "pending", error: null })
    })
  }
  async fail(accountId: string, scope: string, operationId: string | null, message: string, rejected: boolean, now: number) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      const row = await this.get(accountId, scope, tx)
      if (!row.desired || (row.request?.operationId ?? null) !== operationId) return
      await this.write(tx, accountId, { ...row, state: rejected ? "rejected" : "pending", error: message, attempts: row.attempts + 1, nextAttemptMs: now + retryDelayMs(row.attempts) })
    })
  }
  /** Explicit review: keep the user's desired settings, use a fresh server version and a new operation ID. */
  async retry(accountId: string, scope: string, snapshot: NotificationServerSnapshot) {
    if (snapshot.accountId !== accountId || ("householdId" in snapshot ? snapshot.householdId : "device") !== scope) throw new Error("Refresh the matching notification settings.")
    await this.database.withExclusiveTransactionAsync(async tx => {
      await this.allowed(accountId, scope, tx)
      const row = await this.get(accountId, scope, tx)
      if (row.state !== "rejected") return
      const server = !row.server || BigInt(snapshot.revision) >= BigInt(row.server.revision) ? snapshot : row.server
      await this.write(tx, accountId, { ...row, server, request: null, state: "pending", attempts: 0, nextAttemptMs: 0, error: null })
    })
  }
  async discard(accountId: string, scope: string, snapshot: NotificationServerSnapshot) {
    if (snapshot.accountId !== accountId || ("householdId" in snapshot ? snapshot.householdId : "device") !== scope) throw new Error("Refresh the matching notification settings.")
    await this.database.withExclusiveTransactionAsync(async tx => {
      await this.allowed(accountId, scope, tx)
      const row = await this.get(accountId, scope, tx)
      if (row.state !== "rejected") return
      const server = !row.server || BigInt(snapshot.revision) >= BigInt(row.server.revision) ? snapshot : row.server
      await this.write(tx, accountId, { ...row, server, desired: null, request: null, confirmedDesired: "preferences" in server ? server.preferences : null,
        state: "pending", attempts: 0, nextAttemptMs: 0, error: null })
    })
  }
}
