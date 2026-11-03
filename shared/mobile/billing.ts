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
export type NativeBillingAction =
  | { action: "prepare"; householdId: string; store: NativeBillingStore }
  | { action: "begin" | "cancel"; householdId: string; store: NativeBillingStore; interval: NativeBillingInterval; operationId: string }
  | { action: "verify"; householdId: string }
