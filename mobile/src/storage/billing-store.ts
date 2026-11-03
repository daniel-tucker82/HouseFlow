import type { NativeBillingInterval, NativeBillingScope, NativeBillingStore } from "../../../shared/mobile/billing"
import type { LocalDatabase, SqlConnection } from "./local-store"
import { requireKioskParentAccess } from "./kiosk-store"

export interface BillingOperation extends NativeBillingScope {
  id: string
  kind: "purchase" | "restore"
  store: NativeBillingStore
  interval: NativeBillingInterval
  stage: "preflight" | "presenting" | "verify" | "waiting" | "cancel"
  attempts: number
  nextAttemptMs: number
}
/** Only recovery metadata is persisted; no receipts, SDK customer objects or
 * payment details. Late callbacks can update only their original operation. */
export class BillingStore {
  constructor(private readonly db: LocalDatabase) {}
  async initialize() {
    await this.db.execAsync(`CREATE TABLE IF NOT EXISTS native_billing_operations (
      account_id TEXT NOT NULL, household_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL,
      PRIMARY KEY(account_id,household_id));`)
  }
  async read(accountId: string, householdId: string, tx: SqlConnection = this.db): Promise<BillingOperation | null> {
    const row = await tx.getFirstAsync<{ data: string }>("SELECT data FROM native_billing_operations WHERE account_id=? AND household_id=?", accountId,householdId)
    return row ? JSON.parse(row.data) as BillingOperation : null
  }
  private async requireSession(tx: SqlConnection, operation: BillingOperation) {
    await requireKioskParentAccess(tx)
    const active = await tx.getFirstAsync("SELECT 1 FROM notification_sessions WHERE account_id=? AND session_id=? AND revoked=0", operation.accountId,operation.sessionId)
    if (!active) throw new Error("Your sign-in changed. Reopen billing before continuing.")
  }
  async begin(operation: BillingOperation) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      await this.requireSession(tx, operation)
      if (await this.read(operation.accountId,operation.householdId,tx)) throw new Error("Finish checking the earlier purchase before starting another.")
      await tx.runAsync("INSERT INTO native_billing_operations(account_id,household_id,operation_id,data) VALUES(?,?,?,?)",
        operation.accountId,operation.householdId,operation.id,JSON.stringify(operation))
    })
  }
  async update(operation: BillingOperation, patch: Partial<Pick<BillingOperation, "stage" | "attempts" | "nextAttemptMs">>) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      const current = await this.read(operation.accountId,operation.householdId,tx)
      if (!current || current.id !== operation.id) return
      if (patch.stage === "presenting") await this.requireSession(tx, current)
      await tx.runAsync("UPDATE native_billing_operations SET data=? WHERE operation_id=?", JSON.stringify({ ...current, ...patch }), operation.id)
    })
  }
  async clear(operation: BillingOperation) {
    await this.db.runAsync("DELETE FROM native_billing_operations WHERE account_id=? AND household_id=? AND operation_id=?", operation.accountId,operation.householdId,operation.id)
  }
}
