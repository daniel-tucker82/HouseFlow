import type { NativeBillingInterval, NativeBillingSetup, NativeBillingStore } from "../../../shared/mobile/billing"

export interface BillingOffer {
  interval: NativeBillingInterval
  productId: string
  price: string
  currency: string
  amount: number
  reference: unknown
}
export interface IdentifiedBillingStore {
  offers(): Promise<BillingOffer[]>
  purchase(offer: BillingOffer): Promise<"purchased" | "cancelled" | "pending">
  restore(): Promise<void>
}
export interface BillingSdk {
  store: NativeBillingStore | null
  run<T>(setup: NativeBillingSetup, check: () => void, work: (store: IdentifiedBillingStore) => Promise<T>): Promise<T>
  manage(check: () => void): Promise<void>
  openWebCancellation(url: string, check: () => void): Promise<void>
}

/** SDK implementations share this queue across runtimes/accounts. A new login
 * must not change a store customer's identity while its purchase is open. */
export class BillingSdkQueue {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(check: () => void, work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => { check(); return work() })
    this.tail = result.catch(() => undefined)
    return result
  }
}
