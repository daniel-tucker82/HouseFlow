/** Pure policy shared by server enforcement and presentation; never trusts client claims. */
export type HouseholdTier = "free" | "premium" | "owner"

export const SUBSCRIPTION_PRICES = {
  currency: "aud",
  monthly: 599,
  yearly: 4999,
} as const

export interface BillingSnapshot {
  ownerGrant: boolean
  subscriptionStatus: string
  paidThrough: Date | string | null
}

export function resolveHouseholdTier(snapshot: BillingSnapshot, now = new Date()): HouseholdTier {
  // A billing event can never override the independently stored permanent grant.
  if (snapshot.ownerGrant) return "owner"
  const paidUntil = snapshot.paidThrough ? new Date(snapshot.paidThrough).getTime() : 0
  // A failed renewal preserves only time already paid for, without indefinite grace.
  const eligible = ["active", "past_due", "canceled"].includes(snapshot.subscriptionStatus)
  return eligible && Number.isFinite(paidUntil) && paidUntil > now.getTime() ? "premium" : "free"
}

function boundedSetting(value: string | undefined, fallback: number, maximum: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback
}

export function householdLimits(tier: HouseholdTier, settings: Record<string, string | undefined> = {}) {
  if (tier === "free") return { templates: 1, items: 15, activeExecutions: 1, automation: false }
  return {
    templates: boundedSetting(settings.PREMIUM_MAX_TEMPLATES, 50, 500),
    items: boundedSetting(settings.PREMIUM_MAX_ITEMS, 100, 1000),
    activeExecutions: boundedSetting(settings.PREMIUM_MAX_ACTIVE_EXECUTIONS, 100, 1000),
    automation: true,
  }
}

export function retainedTaskLimit(tier: HouseholdTier, settings: Record<string,string|undefined> = {}) {
  return tier === "free" ? boundedSetting(settings.FREE_MAX_RETAINED_TASKS,10000,50000) :
    boundedSetting(settings.PREMIUM_MAX_RETAINED_TASKS,100000,1000000)
}

export function hasTimeRule(value: unknown): boolean {
  if (value == null || value === "") return false
  if (typeof value === "string") {
    try { return hasTimeRule(JSON.parse(value)) } catch { return true }
  }
  if (typeof value !== "object" || Array.isArray(value)) return true
  return (value as Record<string, unknown>).kind !== "none"
}
