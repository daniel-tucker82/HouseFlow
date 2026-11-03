import { accountDeletionOrigin, parseAccountDeletionStatus, validAccountDeletionRecovery,
  type AccountDeletionRecovery, type AccountDeletionStatus } from "../../../shared/mobile/account-deletion"

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
  status: AccountDeletionStatus | null
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
      (row.status !== null && !row.submitted)) throw unavailable()
    return { format: 1, origin: row.origin, accountId: row.accountId, requestId: row.requestId, secret: row.secret, submitted: row.submitted,
      status: row.status === null ? null : parseAccountDeletionStatus(row.status, row.requestId) }
  } catch { throw unavailable() }
}

/** Kept outside account caches and sign-out cleanup. Save before the destructive
 * request, then markSubmitted before sending any bytes. A 404/network failure
 * never clears this record: neither proves that submission was not accepted.
 * The acceptance caller must also retain its original intent for safe replay.
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
        secret: await this.randomSecret(), submitted: false, status: null }
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
  markSubmitted(expected: AccountDeletionRecovery) {
    return serial(async () => {
      const record = await this.require(expected)
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
      if (!record.submitted || (record.status && record.status.acceptedAt !== status.acceptedAt)) throw unavailable()
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
}
