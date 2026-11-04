import type { NativeBillingSetup } from "../../../shared/mobile/billing"
import { notificationSessionId, notificationUuid } from "../../../shared/mobile/notification-settings"
import type { LocalDatabase, SqlConnection } from "./local-store"
import { isLocallyDeletedAccount } from "./account-deletion-local"
import { requireKioskParentAccess } from "./kiosk-store"

export type BillingIdentity = Pick<NativeBillingSetup,"accountId" | "sessionId" | "deviceId" | "householdId" | "billingCustomerId" | "publicSdkKey" | "store" | "environment">
export interface BillingIdentityState { revision: number; current: BillingIdentity | null; pending: BillingIdentity | null }
const unavailable = () => new Error("Saved store identity needs recovery before billing can continue.")
export function billingIdentity(value: unknown): BillingIdentity {
  const row = value as Partial<BillingIdentity> | null
  if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.accountId !== "string" || !/^user_[A-Za-z0-9_-]{1,200}$/.test(row.accountId) ||
    typeof row.sessionId !== "string" || !notificationSessionId.test(row.sessionId) || typeof row.deviceId !== "string" || !notificationUuid.test(row.deviceId) ||
    typeof row.householdId !== "string" || !notificationUuid.test(row.householdId) || typeof row.billingCustomerId !== "string" || !notificationUuid.test(row.billingCustomerId) ||
    !["app_store","play_store"].includes(row.store ?? "") || !["sandbox","production"].includes(row.environment ?? "") || typeof row.publicSdkKey !== "string" ||
    !(row.store === "app_store" ? /^appl_[A-Za-z0-9]+$/ : /^goog_[A-Za-z0-9]+$/).test(row.publicSdkKey)) throw unavailable()
  return {accountId:row.accountId,sessionId:row.sessionId,deviceId:row.deviceId,householdId:row.householdId,billingCustomerId:row.billingCustomerId,
    publicSdkKey:row.publicSdkKey,store:row.store!,environment:row.environment!}
}

/** Global SDK ownership, retained through account-cache erasure until the SDK
 * confirms detachment. Only opaque IDs/public configuration, never customer
 * objects, receipts, credentials or offerings. Both sides of an uncertain
 * identity change survive process death. */
export class BillingIdentityStore {
  constructor(private readonly db: LocalDatabase) {}
  initialize() {
    return this.db.execAsync(`CREATE TABLE IF NOT EXISTS native_billing_identity (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL);
      INSERT OR IGNORE INTO native_billing_identity VALUES(1,0,'{"current":null,"pending":null}');`)
  }
  async read(tx: SqlConnection = this.db): Promise<BillingIdentityState> {
    const row = await tx.getFirstAsync<{revision:number;data:string}>("SELECT revision,data FROM native_billing_identity WHERE id=1")
    try {
      if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.data.length > 8192) throw unavailable()
      const data = JSON.parse(row.data)
      return {revision:row.revision,current:data.current === null ? null : billingIdentity(data.current),pending:data.pending === null ? null : billingIdentity(data.pending)}
    } catch {throw unavailable()}
  }
  isDeleted(accountId: string) { return isLocallyDeletedAccount(this.db,accountId) }
  private async write(tx: SqlConnection, expected: BillingIdentityState, current: BillingIdentity | null, pending: BillingIdentity | null) {
    const saved = await this.read(tx)
    if (JSON.stringify(saved) !== JSON.stringify(expected)) throw unavailable()
    await tx.runAsync("UPDATE native_billing_identity SET revision=revision+1,data=? WHERE id=1",JSON.stringify({current,pending}))
  }
  async begin(value: BillingIdentity, expected: BillingIdentityState) {
    const identity = billingIdentity(value)
    await this.db.withExclusiveTransactionAsync(async tx => {
      await requireKioskParentAccess(tx)
      if (await isLocallyDeletedAccount(tx,identity.accountId) || !await tx.getFirstAsync("SELECT 1 FROM notification_sessions WHERE account_id=? AND session_id=? AND revoked=0",identity.accountId,identity.sessionId)) {
        throw new Error("Your sign-in changed. Reopen billing before continuing.")
      }
      if (expected.pending) throw unavailable()
      await this.write(tx,expected,expected.current,identity)
    })
    return this.read()
  }
  /** Native identity has been read AFTER an SDK transition settles. This may
   * finish after sign-out/deletion; retaining its scope enables cleanup. */
  async settle(expected: BillingIdentityState, current: BillingIdentity | null) {
    if (current && ![expected.current,expected.pending].some(item => JSON.stringify(item) === JSON.stringify(current))) throw unavailable()
    await this.db.withExclusiveTransactionAsync(tx => this.write(tx,expected,current,null))
    return this.read()
  }
}
