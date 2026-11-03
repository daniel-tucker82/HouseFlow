import { normalizeAccountDeletionSubmission, validAccountDeletionRecovery, type AccountDeletionRecovery, type AccountDeletionScope, type AccountDeletionSubmission } from "../../../shared/mobile/account-deletion"
import type { AccountDeletionStore, SavedDeletionIntent } from "../storage/account-deletion-store"
import type { AccountDeletionVault, SavedAccountDeletion } from "../storage/account-deletion-vault"

let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>) {
  const result = queue.then(work, work); queue = result.catch(() => undefined); return result
}
const mismatch = () => new Error("The saved deletion request does not match its recovery information. Keep both and contact Cyntch support.")

/** Serializes the two durable stores. No network call or automatic destructive
 * retry is made here. requestForSubmission returns only AFTER both stores commit;
 * the HTTP caller must still enforce current parent authentication/reverification.
 */
export class AccountDeletionDrafts {
  constructor(private readonly journal: AccountDeletionStore, private readonly vault: AccountDeletionVault,
    private readonly digest: (value: string) => Promise<string>, private readonly allowDevelopmentHttp = false) {}
  private async fingerprint(submission: AccountDeletionSubmission, recovery: AccountDeletionRecovery) {
    const fingerprint = await this.digest(`cyntch-deletion-intent-v1:${JSON.stringify(submission)}:${recovery.secret}`)
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw mismatch()
    return fingerprint
  }
  private async recovery(expected: AccountDeletionRecovery) {
    const record = await this.vault.read()
    if (!validAccountDeletionRecovery(expected) || !record || record.requestId !== expected.requestId || record.secret !== expected.secret) throw mismatch()
    return record
  }
  private async match(record: SavedAccountDeletion, intent: SavedDeletionIntent, requireBound = true) {
    const { submission, fingerprint } = intent
    if (record.origin !== submission.origin || record.accountId !== submission.accountId || record.requestId !== submission.intent.operationId ||
      fingerprint !== await this.fingerprint(submission, record) || (record.intentHash !== fingerprint && (requireBound || record.intentHash !== null))) throw mismatch()
  }
  prepare(value: AccountDeletionSubmission) {
    const submission = normalizeAccountDeletionSubmission(value, this.allowDevelopmentHttp)
    return serial(async () => {
      const recovery = await this.vault.prepare(submission.origin, submission.accountId, submission.intent.operationId)
      if (recovery.submitted || recovery.status) throw new Error("This deletion was already submitted. Check its saved status.")
      const fingerprint = await this.fingerprint(submission, recovery)
      await this.journal.prepare(submission, fingerprint)
      return this.vault.bindIntent(recovery, fingerprint)
    })
  }
  requestForSubmission(expected: AccountDeletionRecovery, current: AccountDeletionScope) {
    return serial(async () => {
      const recovery = await this.recovery(expected), intent = await this.journal.read()
      if (recovery.status) throw new Error("Deletion has already been accepted. Check its saved status.")
      if (!intent) throw mismatch()
      await this.match(recovery, intent)
      // Vault first: killing the process at either write cannot turn a possibly
      // submitted operation back into a cancellable local preparation.
      await this.vault.markSubmitted(recovery, intent.fingerprint)
      await this.journal.markSubmitted(intent, current)
      return { ...intent.submission, recovery: { requestId: recovery.requestId, secret: recovery.secret } }
    })
  }
  discardPrepared(expected: AccountDeletionRecovery) {
    return serial(async () => {
      const recovery = await this.recovery(expected), intent = await this.journal.read()
      if (recovery.submitted) throw new Error("This deletion may already be accepted. Keep its recovery information and check its status.")
      if (intent) {
        await this.match(recovery, intent, false)
        // Journal first: interruption leaves a never-submitted vault record
        // which can safely be discarded on the next explicit cancellation.
        await this.journal.discardPrepared(intent)
      }
      await this.vault.discardPrepared(recovery)
    })
  }
  rememberStatus(expected: AccountDeletionRecovery, value: unknown) {
    return serial(async () => {
      const record = await this.vault.rememberStatus(expected, value), intent = await this.journal.read()
      if (intent) {
        await this.match(record, intent)
        await this.journal.clearConfirmed(intent)
      }
      return record
    })
  }
}
