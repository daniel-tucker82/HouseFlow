import { normalizeAccountDeletionSubmission, type AccountDeletionScope, type AccountDeletionSubmission } from "../../../shared/mobile/account-deletion"
import type { LocalDatabase, SqlConnection } from "./local-store"
import { requireKioskParentAccess } from "./kiosk-store"

export interface SavedDeletionIntent { submission: AccountDeletionSubmission; fingerprint: string; submitted: boolean }
type Row = { operation_id: string; data: string; fingerprint: string; submitted: number }
const invalid = () => new Error("The saved deletion request cannot be read safely. Keep its recovery information and contact Cyntch support.")
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

/** Immutable, canonical intent only. The 256-bit recovery key and sign-in tokens
 * are NEVER stored in SQLite. One slot matches the installation's secure vault.
 * This journal survives sign-out and is removed after confirmed acceptance. */
export class AccountDeletionStore {
  constructor(private readonly db: LocalDatabase) {}
  initialize() {
    return this.db.execAsync(`CREATE TABLE IF NOT EXISTS native_account_deletion_intent (
      id INTEGER PRIMARY KEY CHECK(id=1), operation_id TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL, fingerprint TEXT NOT NULL, submitted INTEGER NOT NULL CHECK(submitted IN (0,1)));`)
  }
  async read(tx: SqlConnection = this.db): Promise<SavedDeletionIntent | null> {
    const row = await tx.getFirstAsync<Row>("SELECT operation_id,data,fingerprint,submitted FROM native_account_deletion_intent WHERE id=1")
    if (!row) return null
    try {
      if (row.data.length > 65536 || !hash(row.fingerprint) || ![0,1].includes(row.submitted)) throw invalid()
      const submission = normalizeAccountDeletionSubmission(JSON.parse(row.data), true)
      if (row.operation_id !== submission.intent.operationId) throw invalid()
      return { submission, fingerprint: row.fingerprint, submitted: row.submitted === 1 }
    } catch { throw invalid() }
  }
  private async requireSession(tx: SqlConnection, saved: AccountDeletionScope, current: AccountDeletionScope) {
    await requireKioskParentAccess(tx)
    if (saved.accountId !== current.accountId || saved.sessionId !== current.sessionId || saved.deviceId !== current.deviceId ||
      !await tx.getFirstAsync("SELECT 1 FROM notification_sessions WHERE account_id=? AND session_id=? AND revoked=0", saved.accountId, saved.sessionId)) {
      throw new Error("Your sign-in changed. Check the saved deletion request before continuing.")
    }
  }
  async prepare(value: AccountDeletionSubmission, fingerprint: string) {
    const submission = normalizeAccountDeletionSubmission(value, true)
    if (!hash(fingerprint)) throw invalid()
    await this.db.withExclusiveTransactionAsync(async tx => {
      await this.requireSession(tx, submission, submission)
      const prior = await this.read(tx)
      if (prior) {
        if (prior.fingerprint !== fingerprint || JSON.stringify(prior.submission) !== JSON.stringify(submission) || prior.submitted) throw invalid()
        return
      }
      await tx.runAsync("INSERT INTO native_account_deletion_intent(id,operation_id,data,fingerprint,submitted) VALUES(1,?,?,?,0)",
        submission.intent.operationId, JSON.stringify(submission), fingerprint)
    })
  }
  private async require(tx: SqlConnection, expected: SavedDeletionIntent) {
    const current = await this.read(tx)
    if (!current || current.fingerprint !== expected.fingerprint || JSON.stringify(current.submission) !== JSON.stringify(expected.submission)) throw invalid()
    return current
  }
  async markSubmitted(expected: SavedDeletionIntent, scope: AccountDeletionScope) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      const current = await this.require(tx, expected)
      await this.requireSession(tx, current.submission, scope)
      await tx.runAsync("UPDATE native_account_deletion_intent SET submitted=1 WHERE id=1")
    })
  }
  async discardPrepared(expected: SavedDeletionIntent) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      await requireKioskParentAccess(tx)
      const current = await this.require(tx, expected)
      if (current.submitted) throw invalid()
      await tx.runAsync("DELETE FROM native_account_deletion_intent WHERE id=1")
    })
  }
  /** Caller first durably saves the server's accepted status in the vault. */
  async clearConfirmed(expected: SavedDeletionIntent) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      await this.require(tx, expected)
      await tx.runAsync("DELETE FROM native_account_deletion_intent WHERE id=1")
    })
  }
}
