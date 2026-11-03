import type { HouseholdSummary } from "../../../shared/mobile/contracts"
import type { NativeBillingScope, NativeBillingSetup, NativeBillingStatus, NativeBillingStore, NativeBillingInterval, WebBillingCancellation } from "../../../shared/mobile/billing"
import type { BillingOperation, BillingStore } from "../storage/billing-store"
import { TransportError } from "../storage/sync-engine"
import type { BillingOffer, BillingSdk } from "./billing-sdk"

interface BillingApi {
  billingStatus(householdId: string): Promise<NativeBillingStatus>
  prepareBilling(householdId: string, store: NativeBillingStore): Promise<NativeBillingSetup>
  billingPurchase(action: { action: "begin" | "cancel"; householdId: string; store: NativeBillingStore; interval: NativeBillingInterval; operationId: string }): Promise<unknown>
  verifyBilling(householdId: string): Promise<NativeBillingStatus>
  webBillingCancellation(householdId: string): Promise<WebBillingCancellation>
}
export interface BillingState {
  household: HouseholdSummary | null
  status: NativeBillingStatus | null
  operation: BillingOperation | null
  offers: BillingOffer[]
  busy: "prices" | "purchase" | "restore" | "manage" | null
  loading: boolean
  online: boolean
  error: string | null
  message: string | null
}
function retryMs(attempts: number) { return Math.min(60_000, 2000 * 2 ** Math.min(attempts, 5)) }
// Runtime remounts do not end an OS purchase sheet. Recovery must wait for its
// callback. Process death clears this set, allowing durable recovery on restart.
const liveOperations = new Set<string>()
export function hasBillingConflict(status: NativeBillingStatus) {
  return status.tier !== "free" || Boolean(status.purchase) || status.sources.some(source => source.pendingPayment || source.givesAccess ||
    (source.provider === "stripe" ? !["none", "canceled", "incomplete_expired"].includes(source.status) : !["expired", "not_returned"].includes(source.status)))
}
export class BillingController {
  private state: BillingState = { household: null, status: null, operation: null, offers: [], busy: null, loading: false, online: false, error: null, message: null }
  private listeners = new Set<() => void>()
  private generation = 0
  private stopped = false
  private active = false
  private visible = false
  private running: Promise<void> | null = null
  private performing = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly store: BillingStore, private readonly identity: Omit<NativeBillingScope, "householdId">,
    private readonly api: BillingApi, private readonly sdk: BillingSdk, private readonly allowed: (householdId: string) => boolean,
    private readonly uuid: () => string, private readonly now: () => number = Date.now) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<BillingState>) { if (!this.stopped) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()) } }
  private current(generation: number, householdId: string) { return !this.stopped && this.generation === generation && this.state.household?.id === householdId && this.allowed(householdId) }
  private check(generation: number, householdId: string) {
    if (!this.current(generation,householdId) || !this.active || !this.state.online) throw new Error("Billing was interrupted. Reopen it when this household is online and unlocked.")
  }
  selectHousehold(household: HouseholdSummary | null) {
    if (this.state.household?.id === household?.id) { if (household !== this.state.household) this.update({ household }); return }
    this.generation++; clearTimeout(this.timer)
    this.update({ household, status: null, operation: null, offers: [], error: null, message: null, loading: false, busy: this.performing ? this.state.busy : null })
    this.wake()
  }
  setConnectivity(online: boolean) { if (online === this.state.online) return; this.update({ online }); if (online) this.wake(); else clearTimeout(this.timer) }
  setActive(active: boolean) { this.active = active; if (active) this.wake(); else clearTimeout(this.timer) }
  setVisible(visible: boolean) { this.visible = visible; if (visible) this.wake() }
  private wake(delay = 0) {
    clearTimeout(this.timer)
    if (this.stopped || !this.active || !this.state.online || !this.state.household || this.running || this.performing || !this.allowed(this.state.household.id)) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh().catch(() => undefined) }, delay)
  }
  async refresh() {
    if (this.running) return this.running
    if (!this.active || !this.state.online || !this.state.household || this.performing || this.stopped) return
    const householdId = this.state.household.id, generation = this.generation
    this.running = this.recover(generation, householdId).catch(error => {
      if (this.current(generation,householdId)) this.update({ error: error instanceof Error ? error.message : "Unable to check the household plan." })
    }).finally(() => {
      this.running = null
      if (this.current(generation,householdId)) {
        this.update({ loading: false })
        if (this.state.operation) this.wake(Math.max(2000, this.state.operation.nextAttemptMs - this.now()))
        else if (this.state.status?.verificationPending && this.visible) this.wake(15_000)
      } else this.wake()
    })
    return this.running
  }
  private async recover(generation: number, householdId: string) {
    this.check(generation,householdId)
    let operation = await this.store.read(this.identity.accountId,householdId)
    this.check(generation,householdId)
    if (operation && liveOperations.has(operation.id)) {
      this.update({ operation: { ...operation, nextAttemptMs: this.now() + 15_000 } })
      return
    }
    // Never reopen a store sheet after process death. An untouched preflight can
    // be cancelled; an uncertain sheet/restore must be verified.
    if (operation?.stage === "preflight" || operation?.stage === "presenting") {
      const stage = operation.stage === "preflight" && operation.kind === "purchase" && operation.sessionId === this.identity.sessionId ? "cancel" : "verify"
      await this.store.update(operation,{ stage, nextAttemptMs: 0 }); operation = { ...operation, stage, nextAttemptMs: 0 }
    }
    this.check(generation,householdId)
    this.update({ operation, loading: !this.state.status })
    let status: NativeBillingStatus
    try {
      this.check(generation,householdId)
      if (operation && operation.nextAttemptMs <= this.now() && operation.stage === "cancel" && operation.sessionId === this.identity.sessionId) {
        try { await this.api.billingPurchase({ action: "cancel", householdId, store: operation.store, interval: operation.interval, operationId: operation.id }) }
        catch (error) { if (!(error instanceof TransportError && error.code === "attempt_mismatch")) throw error }
        await this.store.clear(operation); operation = null
        this.check(generation,householdId)
      }
      if (operation && operation.stage === "cancel" && operation.sessionId !== this.identity.sessionId) {
        await this.store.update(operation,{ stage: "verify", nextAttemptMs: 0 }); operation = { ...operation, stage: "verify", nextAttemptMs: 0 }
      }
      if (operation?.stage === "verify" && operation.nextAttemptMs <= this.now()) {
        status = await this.api.verifyBilling(householdId)
        await this.store.update(operation,{ stage: "waiting", attempts: 0, nextAttemptMs: this.now() + 3000 })
        operation = { ...operation, stage: "waiting", attempts: 0, nextAttemptMs: this.now() + 3000 }
      } else status = await this.api.billingStatus(householdId)
      this.check(generation,householdId)
      if (operation?.stage === "waiting" && !status.verificationPending && (!status.purchase || status.tier !== "free")) {
        await this.store.clear(operation); operation = null
        this.check(generation,householdId)
        this.update({ message: status.tier !== "free" ? "Premium is ready for this household." : "Purchase check complete. Your current plan is shown below." })
      } else if (operation?.stage === "waiting") {
        const nextAttemptMs = this.now() + retryMs(operation.attempts), attempts = operation.attempts + 1
        await this.store.update(operation,{ nextAttemptMs, attempts }); operation = { ...operation, nextAttemptMs, attempts }
      }
      this.check(generation,householdId)
      this.update({ status, operation, error: null })
    } catch (error) {
      if (operation) {
        const nextAttemptMs = this.now() + retryMs(operation.attempts), attempts = operation.attempts + 1
        await this.store.update(operation,{ nextAttemptMs, attempts })
        if (this.current(generation,householdId)) this.update({ operation: { ...operation, nextAttemptMs, attempts } })
      }
      throw error
    }
  }
  private async trackOperation<T>(operation: BillingOperation, work: () => Promise<T>) {
    liveOperations.add(operation.id)
    try { return await work() }
    finally { liveOperations.delete(operation.id) }
  }
  private async action<T>(kind: NonNullable<BillingState["busy"]>, work: (householdId: string, generation: number) => Promise<T>) {
    if (this.performing || this.running) throw new Error("Wait for the current billing check to finish.")
    const householdId = this.state.household?.id, generation = this.generation
    if (!householdId) throw new Error("Choose a household first.")
    this.check(generation,householdId)
    this.performing = true
    this.update({ busy: kind, error: null, message: null }); clearTimeout(this.timer)
    try { return await work(householdId,generation) }
    catch (error) {
      if (this.current(generation,householdId)) this.update({ error: error instanceof Error ? error.message : "Unable to contact the store." })
      throw error
    } finally {
      this.performing = false
      this.update({ busy: null })
      this.wake()
    }
  }
  private async setup(householdId: string, generation: number) {
    if (!this.sdk.store) throw new Error("Use the Android or iOS app to manage store subscriptions.")
    const setup = await this.api.prepareBilling(householdId,this.sdk.store); this.check(generation,householdId)
    return setup
  }
  async loadOffers() {
    return this.action("prices",async (householdId,generation) => {
      const setup = await this.setup(householdId,generation)
      const offers = await this.sdk.run(setup,() => this.check(generation,householdId),session => session.offers())
      this.check(generation,householdId); this.update({ offers })
    })
  }
  async purchase(interval: NativeBillingInterval) {
    return this.action("purchase",async (householdId,generation) => {
      const shown = this.state.offers.find(offer => offer.interval === interval)
      if (!shown) throw new Error("Load the store price before subscribing.")
      const status = await this.api.billingStatus(householdId); this.check(generation,householdId)
      this.update({ status })
      if (!status.canManage || !status.purchasesAvailable || hasBillingConflict(status)) throw new Error("Check the household’s existing subscription before purchasing.")
      const setup = await this.setup(householdId,generation)
      await this.sdk.run(setup,() => this.check(generation,householdId),async session => {
        const offers = await session.offers(); this.check(generation,householdId)
        const offer = offers.find(item => item.interval === interval)
        this.update({ offers })
        if (!offer || offer.amount !== shown.amount || offer.currency !== shown.currency || offer.productId !== shown.productId) throw new Error("The store price changed. Review the updated price before subscribing.")
        const operation: BillingOperation = { ...this.identity, householdId, id: this.uuid(), kind: "purchase", store: setup.store,
          interval, stage: "preflight", attempts: 0, nextAttemptMs: 0 }
        await this.trackOperation(operation, async () => {
          await this.store.begin(operation)
          let presented = false
          try {
            this.check(generation,householdId)
            await this.api.billingPurchase({ action: "begin", householdId, store: setup.store, interval, operationId: operation.id })
            this.check(generation,householdId)
            await this.store.update(operation,{ stage: "presenting" }); this.check(generation,householdId)
            presented = true
            const result = await session.purchase(offer)
            await this.store.update(operation,{ stage: result === "cancelled" ? "cancel" : "verify", nextAttemptMs: 0 })
            if (this.current(generation,householdId)) this.update({ message: result === "cancelled" ? "Purchase cancelled." : result === "pending" ? "The store is waiting for payment or approval. Your plan will update after confirmation." : "Purchase received. Checking your household’s Premium access…" })
          } catch (error) {
            await this.store.update(operation,{ stage: presented ? "verify" : "cancel", nextAttemptMs: 0 })
            throw error
          }
        })
      })
    })
  }
  async restore() {
    return this.action("restore",async (householdId,generation) => {
      const setup = await this.setup(householdId,generation)
      await this.sdk.run(setup,() => this.check(generation,householdId),async session => {
        const existing = await this.store.read(this.identity.accountId,householdId)
        const operation: BillingOperation = existing ?? { ...this.identity, householdId, id: this.uuid(), kind: "restore", store: setup.store,
          interval: "monthly", stage: "preflight", attempts: 0, nextAttemptMs: 0 }
        await this.trackOperation(operation, async () => {
          if (!existing) await this.store.begin(operation)
          try {
            this.check(generation,householdId)
            await this.api.verifyBilling(householdId); this.check(generation,householdId)
            // Do not relabel a prior session's operation as a new store purchase.
            if (!existing) await this.store.update(operation,{ stage: "presenting" })
            this.check(generation,householdId); await session.restore()
            if (this.current(generation,householdId)) this.update({ message: "Restored store purchases. Checking this household’s access…" })
          } finally { await this.store.update(operation,{ stage: "verify", nextAttemptMs: 0, attempts: 0 }) }
        })
      })
    })
  }
  async manage(provider: NativeBillingStore | null = this.sdk.store) {
    return this.action("manage",async (householdId,generation) => {
      const status = await this.api.billingStatus(householdId); this.check(generation,householdId)
      this.update({ status })
      if (!status.canManage || !provider || !status.sources.some(source => source.provider === provider)) throw new Error("This household has no subscription you can manage in that store.")
      await this.sdk.manage(provider,() => this.check(generation,householdId))
    })
  }
  async cancelWebRenewal() {
    return this.action("manage",async (householdId,generation) => {
      const destination = await this.api.webBillingCancellation(householdId); this.check(generation,householdId)
      await this.sdk.openWebCancellation(destination.url,() => this.check(generation,householdId))
      if (this.current(generation,householdId)) this.update({ message: "Confirm cancellation with Stripe. Any remaining paid access is preserved; the plan updates after confirmation." })
    })
  }
  stop() { this.stopped = true; this.generation++; clearTimeout(this.timer); this.listeners.clear() }
}
