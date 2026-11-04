import type { BillingIdentity, BillingIdentityState, BillingIdentityStore } from "../storage/billing-identity-store"
import { billingIdentity } from "../storage/billing-identity-store"
import { BillingSdkQueue } from "./billing-sdk"

export interface BillingIdentityDriver {
  isConfigured(): Promise<boolean>
  configure(identity: BillingIdentity, resumeCachedIdentity: boolean, check: () => void): Promise<void>
  current(): Promise<string>
  isAnonymous(): Promise<boolean>
  logIn(customerId: string, check: () => void): Promise<void>
  logOut(): Promise<void>
}
const recoveryNeeded = () => new Error("Store identity cleanup needs another attempt. Your saved recovery information has been kept.")

/** One queue covers configure/login, every purchase/restore and logout. A
 * timed-out caller does not release an underlying native operation's place.
 * The journal commits before a call which can change the SDK's cached identity.
 * This does not claim to erase the remote RevenueCat customer. */
export class BillingIdentityController {
  private readonly queue = new BillingSdkQueue()
  private readonly fenced = new Set<string>()
  constructor(private readonly store: BillingIdentityStore, private readonly driver: BillingIdentityDriver) {}
  private async reconcile(state: BillingIdentityState, check: () => void = () => {}) {
    const saved = state.pending ?? state.current
    if (!saved) return state
    check()
    const configured = await this.driver.isConfigured();check()
    if (!configured) {await this.driver.configure(saved,true,check);check()}
    const id = await this.driver.current();check()
    const matching = state.pending?.billingCustomerId === id ? state.pending : state.current?.billingCustomerId === id ? state.current : null
    if (!matching && !await this.driver.isAnonymous()) throw recoveryNeeded()
    check()
    return this.store.settle(state,matching)
  }
  private async detach(state: BillingIdentityState) {
    if (!state.current) return state
    await this.driver.logOut()
    // A successful response alone is insufficient if another native caller has
    // changed identity. This application must be the SDK's only identity owner.
    if (!await this.driver.isAnonymous() || await this.driver.current() === state.current.billingCustomerId) throw recoveryNeeded()
    return this.store.settle(state,null)
  }
  run<T>(value: BillingIdentity, check: () => void, work: (check: () => void) => Promise<T>) {
    const identity = billingIdentity(value)
    let leaseOpen = true
    const guard = () => {
      check()
      if (!leaseOpen) throw new Error("This store operation has ended. Reopen billing before continuing.")
      if (this.fenced.has(identity.accountId)) throw new Error("This account has been deleted. Sign in with another account.")
    }
    return this.queue.run(guard,async () => {
      try {
        if (await this.store.isDeleted(identity.accountId)) {this.fenced.add(identity.accountId);guard()}
        let state = await this.store.read()
        // Project/key changes require an explicit migration, never reuse a
        // customer UUID against an unrelated RevenueCat project.
        if ([state.current,state.pending].some(item => item && (item.publicSdkKey !== identity.publicSdkKey || item.store !== identity.store))) throw new Error("Store configuration changed. Its saved identity needs recovery first.")
        state = await this.reconcile(state,guard);guard()
        if (state.current && await this.store.isDeleted(state.current.accountId)) state = await this.detach(state)
        guard()
        if (!state.current && await this.driver.isConfigured()) {
          const id = await this.driver.current()
          if (id !== identity.billingCustomerId && !await this.driver.isAnonymous()) throw recoveryNeeded()
        }
        state = await this.store.begin(identity,state);guard()
        const configured = await this.driver.isConfigured();guard()
        if (!configured) {await this.driver.configure(identity,false,guard);guard()}
        const current = await this.driver.current();guard()
        if (current !== identity.billingCustomerId) {
          const anonymous = await this.driver.isAnonymous();guard()
          if (anonymous) {
            // Anonymous -> logIn aliases the anonymous customer into the next
            // household, which can change originalAppUserId. Configure with an
            // explicit ID instead. First reset the *configuration* to cached
            // identity: both pinned SDKs deduplicate the original configuration
            // even after logIn/logOut changed the actual customer. Without this
            // step, returning to the initially configured household is a no-op.
            // Only the detached identity is resumed; no live purchase can run
            // while this queue owns the SDK.
            await this.driver.configure(identity,true,guard);guard()
            if (await this.driver.current() !== current) throw recoveryNeeded()
            guard()
            await this.driver.configure(identity,false,guard);guard()
          } else {await this.driver.logIn(identity.billingCustomerId,guard);guard()}
        }
        if (await this.driver.current() !== identity.billingCustomerId) throw recoveryNeeded()
        await this.store.settle(state,identity)
        guard()
        const result = await work(guard)
        guard()
        return result
      } finally {leaseOpen = false}
    })
  }
  async eraseDeletedAccount(accountId: string) {
    if (!await this.store.isDeleted(accountId)) throw new Error("Confirm account deletion before clearing its store identity.")
    this.fenced.add(accountId)
    return this.queue.run(() => {},async () => {
      let state = await this.store.read()
      if (![state.current,state.pending].some(item => item?.accountId === accountId)) return
      state = await this.reconcile(state)
      if (state.current?.accountId === accountId) await this.detach(state)
    })
  }
}

export async function waitForBillingIdentityCleanup(work: Promise<void>, timeoutMs = 8_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {await Promise.race([work,new Promise<never>((_,reject) => {timeout = setTimeout(() => reject(recoveryNeeded()),timeoutMs)})])}
  finally {clearTimeout(timeout)}
}
