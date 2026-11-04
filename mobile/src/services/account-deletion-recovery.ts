import { parseAccountDeletionStatus, type AccountDeletionRecovery } from "../../../shared/mobile/account-deletion"
import type { AccountDeletionDrafts } from "./account-deletion-drafts"
import type { AccountDeletionStatusApi } from "./account-deletion-status"
import type { AccountDeletionVault, SavedAccountDeletion } from "../storage/account-deletion-vault"

export interface DeletionRecoveryState {
  ready: boolean; busy: boolean; record: SavedAccountDeletion | null; deletedAccounts: string[]; error: string | null; localCleanupComplete: boolean
}
/** Independent of Clerk and signed-in runtimes. No submission is retried here.
 * Receipt persistence precedes local erasure; failures retain both recovery and
 * the account fence. A late response cannot replace a different saved request. */
export class AccountDeletionRecoveryController {
  private state: DeletionRecoveryState = {ready:false,busy:false,record:null,deletedAccounts:[],error:null,localCleanupComplete:false}
  private listeners = new Set<() => void>()
  private tail: Promise<unknown> = Promise.resolve()
  private identityRecovery: Promise<void> | null = null
  private identityChangedAgain = false
  constructor(private readonly vault: AccountDeletionVault, private readonly drafts: AccountDeletionDrafts, private readonly api: AccountDeletionStatusApi,
    private readonly cleanup: (record: SavedAccountDeletion) => Promise<void>, private readonly deletedAccounts: () => Promise<string[]>,
    private readonly cleanupRetiredIdentity: (accountId: string) => Promise<void>) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.state
  private publish(patch: Partial<DeletionRecoveryState>) { this.state = {...this.state,...patch};for (const listener of this.listeners) listener() }
  private run<T>(work: () => Promise<T>) {
    const result = this.tail.then(async () => {
      this.publish({busy:true,error:null})
      try { return await work() }
      catch (error) { this.publish({error:error instanceof Error ? error.message : "Unable to finish account recovery. Your saved request has been kept."});throw error }
      finally { this.publish({busy:false}) }
    })
    this.tail = result.catch(() => undefined);return result
  }
  private async restore() {
    let record = await this.vault.read()
    if (record?.withdrawal) { await this.drafts.finishWithdrawal(record);record = await this.vault.read() }
    const accounts = await this.deletedAccounts()
    this.publish({ready:true,record,deletedAccounts:accounts,localCleanupComplete:false})
    if (record?.status) {
      // Publish acceptance first so React can immediately hide the old runtime.
      this.publish({deletedAccounts:[...new Set([...accounts,record.accountId])]})
      await this.drafts.rememberStatus(record,record.status)
      await this.cleanup(record)
      this.publish({deletedAccounts:await this.deletedAccounts()})
    }
    // Receipt dismissal removes status/recovery secrets, not the durable account
    // fence. SDK callbacks can finish later, including after another sign-in.
    // Never reset the installation's notification session or another account's
    // credentials while repairing these retired identities.
    const retired = accounts.filter(account => account !== (record?.status ? record.accountId : null))
    const results = await Promise.allSettled(retired.map(account => this.cleanupRetiredIdentity(account)))
    if (results.some(result => result.status === "rejected")) throw new Error("Saved sign-in details for a deleted account still need cleanup. Please try again.")
    this.publish({localCleanupComplete:!record || Boolean(record.status)})
    return record
  }
  refresh() { return this.run(() => this.restore()) }
  /** Coalesce lifecycle events, but retain one trailing pass if identity changes
   * during cleanup. Busy/error publications never call this method themselves. */
  recoverIdentity(): Promise<void> {
    this.identityChangedAgain = true
    if (this.identityRecovery) return this.identityRecovery
    const work = (async () => {
      let failure: unknown
      do {
        this.identityChangedAgain = false
        try { await this.refresh();failure = undefined } catch (error) { failure = error }
      } while (this.identityChangedAgain)
      if (failure) throw failure
    })()
    this.identityRecovery = work.finally(() => {
      this.identityRecovery = null
      // An event may arrive after the loop settles but before this completion
      // callback runs. Keep that event rather than dropping the final repair.
      if (this.identityChangedAgain) return this.recoverIdentity()
    })
    return this.identityRecovery
  }
  check() {
    return this.run(async () => {
      const record = await this.vault.read()
      if (!record?.submitted || record.withdrawal) return this.restore()
      const status = await this.api.read(record)
      return this.acceptStatus(record,status)
    })
  }
  rememberStatus(recovery: AccountDeletionRecovery, status: unknown) {
    return this.run(() => this.acceptStatus(recovery,status))
  }
  private async acceptStatus(recovery: AccountDeletionRecovery, status: unknown) {
    const record = await this.vault.read(), receipt = parseAccountDeletionStatus(status,recovery.requestId)
    if (!record?.submitted || record.requestId !== recovery.requestId || record.secret !== recovery.secret || record.withdrawal ||
      (record.status && record.status.acceptedAt !== receipt.acceptedAt)) throw new Error("The deletion receipt does not match the saved request.")
    const latest = record.status?.state === "completed" ? record.status : {...receipt,appleRevocationRequired:receipt.appleRevocationRequired || record.status?.appleRevocationRequired === true}
    this.publish({record:{...record,status:latest},deletedAccounts:[...new Set([...this.state.deletedAccounts,record.accountId])],localCleanupComplete:false})
    await this.drafts.rememberStatus(recovery,latest)
    return this.restore()
  }
  cancelPrepared(recovery: AccountDeletionRecovery) {
    return this.run(async () => { await this.drafts.discardPrepared(recovery);return this.restore() })
  }
  dismissCompleted(recovery: AccountDeletionRecovery) {
    return this.run(async () => {
      const record = await this.restore()
      if (!record || record.requestId !== recovery.requestId || record.secret !== recovery.secret || !this.state.localCleanupComplete) throw new Error("Finish device cleanup before removing this receipt.")
      await this.vault.dismissCompleted(recovery)
      return this.restore()
    })
  }
}
