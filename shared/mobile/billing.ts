export type NativeBillingStore = "app_store" | "play_store"
export type NativeBillingInterval = "monthly" | "yearly"
export interface NativeBillingScope {
  accountId: string
  sessionId: string
  deviceId: string
  householdId: string
}
export interface NativeBillingSource {
  provider: NativeBillingStore | "stripe"
  status: string
  givesAccess: boolean
  accessThrough: string | null
  pendingPayment: boolean
  renewal: string
}
export interface NativeBillingStatus extends NativeBillingScope {
  tier: "free" | "premium" | "owner"
  limits: { templates: number; items: number; activeExecutions: number; automation: boolean }
  canManage: boolean
  purchasesAvailable: boolean
  sources: NativeBillingSource[]
  duplicateSubscriptions: boolean
  verificationPending: boolean
  purchase: null | { id: string | null; provider: NativeBillingStore | "stripe"; interval: NativeBillingInterval; expiresAt: string; thisSession: boolean }
}
export interface NativeBillingSetup extends NativeBillingScope {
  billingCustomerId: string
  publicSdkKey: string
  environment: "production" | "sandbox"
  store: NativeBillingStore
  products: { interval: NativeBillingInterval; storeProductId: string }[]
}
export interface WebBillingCancellation extends NativeBillingScope {
  provider: "stripe"
  url: string
}
/** Short-lived provider sessions must never be persisted or sent to an arbitrary host. */
export function isWebBillingCancellationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.hostname !== "billing.stripe.com" || url.username || url.password || url.port || url.hash) return false
    // Current deep-link sessions use /flow?secret=...; older sessions place the
    // opaque token in the path. Neither form may carry a redirect or extra query.
    if (url.pathname === "/p/session/flow") {
      const entries = [...url.searchParams.entries()]
      return entries.length === 1 && entries[0][0] === "secret" && /^[a-zA-Z0-9_-]+$/.test(entries[0][1])
    }
    return /^\/p\/session\/[a-zA-Z0-9_-]+$/.test(url.pathname) && !url.search
  } catch { return false }
}
export type NativeBillingAction =
  | { action: "prepare"; householdId: string; store: NativeBillingStore }
  | { action: "begin" | "cancel"; householdId: string; store: NativeBillingStore; interval: NativeBillingInterval; operationId: string }
  | { action: "verify"; householdId: string }
  | { action: "webCancellation"; householdId: string }
