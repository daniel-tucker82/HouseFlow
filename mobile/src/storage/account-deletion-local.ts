import { parseAccountDeletionStatus, validAccountDeletionRecovery } from "../../../shared/mobile/account-deletion"
import { notificationUuid } from "../../../shared/mobile/notification-settings"
import type { SavedAccountDeletion } from "./account-deletion-vault"
import type { LocalDatabase, SqlConnection } from "./local-store"

// Keep this inventory explicit. Recovery intent/keychain, installation identity
// and other accounts are deliberately outside the account cache lifecycle.
export const deletionAccountTables = [
  "board_snapshots", "device_sequences", "pending_completions", "device_settings", "revoked_households", "run_snapshots", "run_pages",
  "planner_access", "planner_snapshots", "planner_edits", "planner_creations", "native_notification_settings", "notification_sessions",
  "notification_taps", "notification_history_cache", "notification_history_actions", "native_billing_operations",
] as const

export async function isLocallyDeletedAccount(tx: SqlConnection, accountId: string) {
  return Boolean(await tx.getFirstAsync("SELECT 1 FROM native_deleted_accounts WHERE account_id=?",accountId))
}
export function initializeAccountDeletionFence(tx: SqlConnection) {
  return tx.execAsync(`CREATE TABLE IF NOT EXISTS native_deleted_accounts (
    account_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, kiosk_ids TEXT NOT NULL DEFAULT '[]');`)
}

/** A server-accepted receipt is saved in keychain BEFORE this transaction.
 * Fencing and erasing the account commit together. Database triggers also stop
 * delayed callbacks and a previously mounted runtime from recreating its data.
 * This is logical app-data cleanup, not a claim of forensic flash erasure. */
export class AccountDeletionLocalStore {
  constructor(private readonly db: LocalDatabase) {}
  async initialize() {
    await initializeAccountDeletionFence(this.db)
    for (const table of deletionAccountTables) {
      await this.db.execAsync(`CREATE TRIGGER IF NOT EXISTS deleted_account_insert_${table} BEFORE INSERT ON ${table}
        WHEN EXISTS(SELECT 1 FROM native_deleted_accounts WHERE account_id=NEW.account_id)
        BEGIN SELECT RAISE(ABORT,'This account has been deleted. Sign in with another account.'); END;
        CREATE TRIGGER IF NOT EXISTS deleted_account_update_${table} BEFORE UPDATE ON ${table}
        WHEN EXISTS(SELECT 1 FROM native_deleted_accounts WHERE account_id=NEW.account_id OR account_id=OLD.account_id)
        BEGIN SELECT RAISE(ABORT,'This account has been deleted. Sign in with another account.'); END;`)
    }
    // These two singleton tables bind identity inside their canonical JSON.
    for (const [table,path] of [["native_kiosk_state","$.kiosk.accountId"],["native_account_deletion_intent","$.accountId"]]) {
      for (const operation of ["INSERT","UPDATE"]) await this.db.execAsync(`CREATE TRIGGER IF NOT EXISTS deleted_account_${operation.toLowerCase()}_${table}
        BEFORE ${operation} ON ${table} WHEN NEW.data IS NOT NULL AND
        EXISTS(SELECT 1 FROM native_deleted_accounts WHERE account_id=json_extract(NEW.data,'${path}'))
        BEGIN SELECT RAISE(ABORT,'This account has been deleted. Sign in with another account.'); END;`)
    }
  }
  isDeleted(accountId: string) { return isLocallyDeletedAccount(this.db,accountId) }
  async accounts() { return (await this.db.getAllAsync<{account_id:string}>("SELECT account_id FROM native_deleted_accounts ORDER BY account_id")).map(row => row.account_id) }
  async pendingKioskKeys(accountId: string): Promise<string[]> {
    const row = await this.db.getFirstAsync<{kiosk_ids:string}>("SELECT kiosk_ids FROM native_deleted_accounts WHERE account_id=?",accountId)
    if (!row) return []
    const ids = JSON.parse(row.kiosk_ids) as unknown
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !notificationUuid.test(id))) throw new Error("Device cleanup needs another attempt.")
    return ids
  }
  async eraseAccepted(record: SavedAccountDeletion) {
    if (!validAccountDeletionRecovery(record) || !/^user_[A-Za-z0-9_-]{1,200}$/.test(record.accountId) || !record.submitted || !record.status || record.withdrawal) {
      throw new Error("Confirm account deletion before removing saved data.")
    }
    parseAccountDeletionStatus(record.status,record.requestId)
    await this.db.withExclusiveTransactionAsync(async tx => {
      const prior = await tx.getFirstAsync<{request_id:string}>("SELECT request_id FROM native_deleted_accounts WHERE account_id=?",record.accountId)
      if (prior && prior.request_id !== record.requestId) throw new Error("The deletion receipt does not match this device's cleanup.")
      const kiosk = await tx.getFirstAsync<{id:string}>("SELECT json_extract(data,'$.kiosk.id') AS id FROM native_kiosk_state WHERE json_extract(data,'$.kiosk.accountId')=?",record.accountId)
      if (kiosk && !notificationUuid.test(kiosk.id)) throw new Error("The deleted account's device lock could not be cleared safely.")
      // Retain the exact key ID before removing its SQLite scope. A restart can
      // finish keychain cleanup without touching another account's current PIN.
      await tx.runAsync("INSERT INTO native_deleted_accounts(account_id,request_id,kiosk_ids) VALUES(?,?,?) ON CONFLICT(account_id) DO NOTHING",
        record.accountId,record.requestId,JSON.stringify(kiosk ? [kiosk.id] : []))
      const active = await tx.getFirstAsync("SELECT 1 FROM notification_sessions WHERE account_id=? AND revoked=0",record.accountId)
      if (active) await tx.runAsync("UPDATE notification_native_cleanup SET generation=generation+1 WHERE id=1")
      for (const table of deletionAccountTables) await tx.runAsync(`DELETE FROM ${table} WHERE account_id=?`,record.accountId)
      await tx.runAsync("UPDATE native_kiosk_state SET revision=revision+1,data=NULL WHERE json_extract(data,'$.kiosk.accountId')=?",record.accountId)
    })
  }
  async acknowledgeKioskKey(accountId: string, requestId: string, kioskId: string) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      const row = await tx.getFirstAsync<{kiosk_ids:string}>("SELECT kiosk_ids FROM native_deleted_accounts WHERE account_id=? AND request_id=?",accountId,requestId)
      if (!row) throw new Error("Device cleanup no longer matches this deletion.")
      const ids: string[] = JSON.parse(row.kiosk_ids)
      await tx.runAsync("UPDATE native_deleted_accounts SET kiosk_ids=? WHERE account_id=? AND request_id=?",JSON.stringify(ids.filter(id => id !== kioskId)),accountId,requestId)
    })
  }
}
