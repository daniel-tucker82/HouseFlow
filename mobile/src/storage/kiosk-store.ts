import { parseNativeKioskSession, restrictKioskBoard, type NativeKioskResult, type NativeKioskSession } from "../../../shared/mobile/kiosk"
import { retryDelayMs } from "../../../shared/mobile/sync-policy"
import type { BoardSnapshot } from "../../../shared/mobile/contracts"
import type { LocalDatabase, SqlConnection } from "./local-store"

export interface LocalKiosk {
  kiosk: NativeKioskSession; activationPending: boolean; intent: "lock" | "unlock" | "recover";
  attempts: number; nextAttemptMs: number; error: string | null; blocked: boolean;
  recoverySignOutSessionId: string | null;
}
export type KioskCommand = "activate" | "unlock" | "recover"
export function nextKioskCommand(record: LocalKiosk): KioskCommand | null {
  return record.intent === "recover" ? "recover" : record.intent === "unlock" ? "unlock" : record.activationPending ? "activate" : null
}
export async function readLocalKiosk(tx: SqlConnection): Promise<LocalKiosk | null> {
  const row = await tx.getFirstAsync<{ data: string | null }>("SELECT data FROM native_kiosk_state WHERE id=1")
  if (!row) throw new Error("The device lock could not be read safely. Restart Cyntch.")
  if (row.data === null) return null
  const value = JSON.parse(row.data) as LocalKiosk
  const kiosk = parseNativeKioskSession(value?.kiosk)
  if (kiosk.state !== "locked" || typeof value.activationPending !== "boolean" || !["lock", "unlock", "recover"].includes(value.intent)
    || !Number.isSafeInteger(value.attempts) || value.attempts < 0 || !Number.isSafeInteger(value.nextAttemptMs) || value.nextAttemptMs < 0
    || typeof value.blocked !== "boolean" || (value.recoverySignOutSessionId !== null && typeof value.recoverySignOutSessionId !== "string")
    || (value.error !== null && typeof value.error !== "string")) throw new Error("The device lock could not be read safely. Parent recovery is required.")
  return { ...value, kiosk }
}
export async function kioskRestriction(tx: SqlConnection) {
  const state = await readLocalKiosk(tx)
  return state && state.intent !== "unlock" ? state.kiosk : null
}
export async function requireKioskParentAccess(tx: SqlConnection) {
  if (await kioskRestriction(tx)) throw new Error("Unlock kiosk mode to use parent controls.")
}

/** One durable device lock, independent of authentication and account caches. */
export class KioskStore {
  constructor(private readonly db: LocalDatabase) {}
  initialize() { return this.db.execAsync(`CREATE TABLE IF NOT EXISTS native_kiosk_state (
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT);
    INSERT OR IGNORE INTO native_kiosk_state VALUES(1,0,NULL);`) }
  get() { return readLocalKiosk(this.db) }
  private save(tx: SqlConnection, record: LocalKiosk | null) {
    return tx.runAsync("UPDATE native_kiosk_state SET revision=revision+1,data=? WHERE id=1", record ? JSON.stringify(record) : null)
  }
  async begin(input: NativeKioskSession) {
    const kiosk = parseNativeKioskSession(input)
    if (kiosk.state !== "locked") throw new Error("Choose a new kiosk lock.")
    await this.db.withExclusiveTransactionAsync(async tx => {
      if (await readLocalKiosk(tx)) throw new Error("Finish unlocking the current kiosk before enabling another.")
      // No saved edit is discarded or stranded behind a new account/device lock.
      const pending = await tx.getFirstAsync(`SELECT 1 FROM pending_completions UNION ALL SELECT 1 FROM planner_edits
        UNION ALL SELECT 1 FROM planner_creations LIMIT 1`)
      const notifications = await tx.getAllAsync<{ data: string }>("SELECT data FROM native_notification_settings")
      if (pending || notifications.some(row => JSON.parse(row.data).desired !== null)) throw new Error("Sync or review saved changes on this device before enabling kiosk mode.")
      const drafts = await tx.getAllAsync<{ data: string }>("SELECT data FROM device_settings WHERE setting_key LIKE 'planner-%-draft:%'")
      if (drafts.some(row => JSON.parse(row.data) !== null)) throw new Error("Finish or discard saved routine drafts before enabling kiosk mode.")
      const row = await tx.getFirstAsync<{ data: string }>("SELECT data FROM board_snapshots WHERE account_id=? AND household_id=?", kiosk.accountId, kiosk.householdId)
      if (!row) throw new Error("Load this household's tasks before enabling kiosk mode.")
      const cached = JSON.parse(row.data) as { format?: number; server?: BoardSnapshot; board?: BoardSnapshot } & BoardSnapshot
      const server = cached.format === 3 ? cached.server! : cached
      if (server.household.role !== "manager" || kiosk.visibleMemberIds.some(id => !server.members.some(member => member.id === id))) throw new Error("Refresh the household and choose its current members before enabling kiosk mode.")
      const restricted = restrictKioskBoard(server, kiosk)
      if (!restricted) throw new Error("Choose the household displayed on this device.")
      await this.save(tx, { kiosk, intent: "lock", activationPending: true, attempts: 0, nextAttemptMs: 0, error: null, blocked: false, recoverySignOutSessionId: null })
      await tx.runAsync("DELETE FROM board_snapshots WHERE account_id<>? OR household_id<>?", kiosk.accountId, kiosk.householdId)
      await tx.runAsync("UPDATE board_snapshots SET data=? WHERE account_id=? AND household_id=?", JSON.stringify({ format: 3, server: restricted, board: restricted }), kiosk.accountId, kiosk.householdId)
      for (const table of ["planner_snapshots", "run_snapshots", "run_pages", "native_notification_settings", "notification_taps"]) await tx.runAsync(`DELETE FROM ${table}`)
      await tx.runAsync("UPDATE planner_access SET allowed=0")
      await tx.runAsync("UPDATE notification_native_cleanup SET generation=generation+1 WHERE id=1")
      await tx.runAsync("INSERT INTO device_settings VALUES(?,?,?) ON CONFLICT(account_id,setting_key) DO UPDATE SET data=excluded.data", kiosk.accountId, "selected-household", JSON.stringify(kiosk.householdId))
    })
  }
  /** Caller must successfully verify the PIN before requesting offline unlock. */
  async requestUnlock(id: string) { await this.changeIntent(id, "unlock") }
  async requestRecovery(id: string, signOutSessionId: string | null = null) { await this.changeIntent(id, "recover", signOutSessionId) }
  private async changeIntent(id: string, intent: "unlock" | "recover", signOutSessionId: string | null = null) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      const current = await readLocalKiosk(tx)
      if (!current || current.kiosk.id !== id) throw new Error("The kiosk lock changed. Try again.")
      if (current.intent === "recover" && intent === "unlock") throw new Error("Finish parent sign-in to recover this kiosk.")
      await this.save(tx, { ...current, intent, attempts: 0, nextAttemptMs: 0, error: null, blocked: false, recoverySignOutSessionId: signOutSessionId })
    })
  }
  async acknowledge(id: string, command: KioskCommand, result: NativeKioskResult) {
    let accepted = false
    await this.db.withExclusiveTransactionAsync(async tx => {
      const current = await readLocalKiosk(tx)
      if (!current || current.kiosk.id !== id) return
      if (command === "unlock" && result.cancelledActivation) {
        const receipt = result.cancelledActivation, target = current.kiosk
        if (receipt.id !== id || receipt.accountId !== target.accountId || receipt.deviceId !== target.deviceId || receipt.sessionId !== target.sessionId) throw new Error("The cancellation receipt did not match this device lock.")
        if (current.intent !== "unlock") return
        await this.save(tx, null); accepted = true; return
      }
      if (command === "recover") {
        const receipt = result.recovery, target = current.kiosk
        if (!receipt || receipt.id !== id || receipt.accountId !== target.accountId || receipt.deviceId !== target.deviceId || receipt.sessionId !== target.sessionId) throw new Error("The recovery receipt did not match this device lock.")
        if (current.intent !== "recover") return
        await this.save(tx, null); accepted = true; return
      }
      const returned = parseNativeKioskSession(result.kiosk), target = current.kiosk
      if (JSON.stringify({ ...returned, state: "locked" }) !== JSON.stringify(target)) throw new Error("The kiosk reply did not match this device lock.")
      if (command === "activate" && returned.state === "locked") {
        await this.save(tx, { ...current, activationPending: false, attempts: 0, nextAttemptMs: 0, error: null, blocked: false }); accepted = true
      } else if (returned.state === "unlocked" && current.intent === "unlock") {
        await this.save(tx, null); accepted = true
      } else if (current.intent !== "recover") throw new Error("This kiosk changed on the server. Use the parent PIN or parent sign-in to recover access.")
    })
    return accepted
  }
  async retry(id: string) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      const current = await readLocalKiosk(tx)
      if (current?.kiosk.id === id) await this.save(tx, { ...current, blocked: false, nextAttemptMs: 0, error: null })
    })
  }
  async defer(id: string, command: KioskCommand, message: string, now: number, blocked = false) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      const current = await readLocalKiosk(tx)
      if (!current || current.kiosk.id !== id || nextKioskCommand(current) !== command) return
      await this.save(tx, { ...current, attempts: current.attempts + 1, nextAttemptMs: now + retryDelayMs(current.attempts), error: message, blocked })
    })
  }
}
