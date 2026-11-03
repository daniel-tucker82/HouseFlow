import { accountDeletionOrigin, parseAccountDeletionStatus, parseAccountDeletionWithdrawal, validAccountDeletionRecovery,
  type AccountDeletionRecovery, type AccountDeletionStatus, type AccountDeletionScope, type AccountDeletionWithdrawalResult } from "../../../shared/mobile/account-deletion"

export interface DeletionSecureStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}
export interface SavedAccountDeletion extends AccountDeletionRecovery {
  format: 1
  origin: string
  accountId: string
  submitted: boolean
  intentHash: string | null
  status: AccountDeletionStatus | null
  withdrawal: Extract<AccountDeletionWithdrawalResult, { outcome: "withdrawn" }> | null
}
const key = "cyntch.account-deletion-recovery"
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>) {
  const result = queue.then(work, work)
  queue = result.catch(() => undefined)
  return result
}
const unavailable = () => new Error("The saved deletion recovery information is unavailable. Please retry or contact Cyntch support.")
function parse(raw: string | null): SavedAccountDeletion | null {
  if (raw === null) return null
  try {
    if (raw.length > 4096) throw unavailable()
    const row = JSON.parse(raw) as SavedAccountDeletion
    if (!validAccountDeletionRecovery(row) || row.format !== 1 || typeof row.origin !== "string" || accountDeletionOrigin(row.origin, true) !== row.origin ||
      typeof row.accountId !== "string" || !/^user_[A-Za-z0-9_-]{1,200}$/.test(row.accountId) || typeof row.submitted !== "boolean" ||
      (row.status !== null && !row.submitted) || (row.intentHash != null && (typeof row.intentHash !== "string" || !/^[a-f0-9]{64}$/.test(row.intentHash))) ||
      (row.withdrawal != null && (!row.submitted || row.status !== null))) throw unavailable()
    const withdrawal = row.withdrawal == null ? null : parseAccountDeletionWithdrawal(row.withdrawal,
      { accountId: row.accountId, sessionId: row.withdrawal.sessionId, deviceId: row.withdrawal.deviceId, requestId: row.requestId })
    if (withdrawal && withdrawal.outcome !== "withdrawn") throw unavailable()
    return { format: 1, origin: row.origin, accountId: row.accountId, requestId: row.requestId, secret: row.secret, submitted: row.submitted,
      intentHash: row.intentHash ?? null, withdrawal, status: row.status === null ? null : parseAccountDeletionStatus(row.status, row.requestId) }
  } catch { throw unavailable() }
}

/** Kept outside account caches and sign-out cleanup. Save before the destructive
 * request, then markSubmitted before sending any bytes. A 404/network failure
 * never clears this record: neither proves that submission was not accepted.
 * The original intent is bound here by hash before submission and retained in
 * the separate SQLite journal; household decisions do not belong in keychain.
 * One unresolved deletion per installation prevents replacing a lost receipt.
 */
export class AccountDeletionVault {
  constructor(private readonly storage: DeletionSecureStorage, private readonly randomSecret: () => Promise<string>,
    private readonly allowDevelopmentHttp = false) {}
  read() { return serial(async () => parse(await this.storage.get(key))) }
  prepare(origin: string, accountId: string, requestId: string) {
    const canonical = accountDeletionOrigin(origin, this.allowDevelopmentHttp)
    return serial(async () => {
      const prior = parse(await this.storage.get(key))
      if (prior) {
        if (prior.origin !== canonical || prior.accountId !== accountId || prior.requestId !== requestId) {
          throw new Error("Resolve the saved deletion request before starting another one on this device.")
        }
        return prior
      }
      const record: SavedAccountDeletion = { format: 1, origin: canonical, accountId, requestId,
        secret: await this.randomSecret(), submitted: false, intentHash: null, status: null, withdrawal: null }
      const serialized = JSON.stringify(record)
      parse(serialized)
      await this.storage.set(key, serialized)
      return record
    })
  }
  private async require(expected: AccountDeletionRecovery) {
    if (!validAccountDeletionRecovery(expected)) throw unavailable()
    const current = parse(await this.storage.get(key))
    if (!current || current.requestId !== expected.requestId || current.secret !== expected.secret) throw unavailable()
    return current
  }
  bindIntent(expected: AccountDeletionRecovery, intentHash: string) {
    return serial(async () => {
      const record = await this.require(expected)
      if (typeof intentHash !== "string" || !/^[a-f0-9]{64}$/.test(intentHash) || record.submitted || (record.intentHash !== null && record.intentHash !== intentHash)) throw unavailable()
      if (record.intentHash === null) {
        record.intentHash = intentHash
        await this.storage.set(key, JSON.stringify(record))
      }
      return record
    })
  }
  markSubmitted(expected: AccountDeletionRecovery, intentHash: string) {
    return serial(async () => {
      const record = await this.require(expected)
      if (typeof intentHash !== "string" || !/^[a-f0-9]{64}$/.test(intentHash) || record.intentHash !== intentHash || record.withdrawal) throw unavailable()
      if (!record.submitted) {
        record.submitted = true
        await this.storage.set(key, JSON.stringify(record))
      }
      return record
    })
  }
  rememberStatus(expected: AccountDeletionRecovery, value: unknown) {
    return serial(async () => {
      const record = await this.require(expected), status = parseAccountDeletionStatus(value, record.requestId)
      if (!record.submitted || record.withdrawal || (record.status && record.status.acceptedAt !== status.acceptedAt)) throw unavailable()
      // An older in-flight read must not overwrite completion or remove a
      // previously recorded manual Apple action. Never trust the device clock.
      if (record.status?.state === "completed") return record
      record.status = { ...status, appleRevocationRequired: status.appleRevocationRequired || record.status?.appleRevocationRequired === true }
      await this.storage.set(key, JSON.stringify(record))
      return record
    })
  }
  discardPrepared(expected: AccountDeletionRecovery) {
    return serial(async () => {
      const record = await this.require(expected)
      if (record.submitted) throw new Error("Check the submitted deletion request before removing recovery information.")
      await this.storage.remove(key)
    })
  }
  /** User dismisses the completed receipt after local cleanup and any manual
   * instructions have been presented. Never called by ordinary sign-out. */
  dismissCompleted(expected: AccountDeletionRecovery) {
    return serial(async () => {
      const record = await this.require(expected)
      if (record.status?.state !== "completed") throw new Error("Deletion has not been confirmed complete.")
      await this.storage.remove(key)
    })
  }
  rememberWithdrawal(expected: AccountDeletionRecovery, value: unknown, current: AccountDeletionScope) {
    return serial(async () => {
      const record = await this.require(expected), receipt = parseAccountDeletionWithdrawal(value, { ...current, requestId: record.requestId })
      if (!record.submitted || record.status || record.accountId !== current.accountId || receipt.outcome !== "withdrawn") throw unavailable()
      if (record.withdrawal && record.withdrawal.withdrawnAt !== receipt.withdrawnAt) throw unavailable()
      if (!record.withdrawal) {
        record.withdrawal = receipt
        await this.storage.set(key, JSON.stringify(record))
      }
      return record
    })
  }
  /** The authenticated server permanently fenced this unaccepted operation.
   * Remove only after its journal has been cleared. A 404 is never this proof. */
  dismissWithdrawn(expected: AccountDeletionRecovery) {
    return serial(async () => {
      const record = await this.require(expected)
      if (!record.withdrawal || record.status) throw unavailable()
      await this.storage.remove(key)
    })
  }
}
