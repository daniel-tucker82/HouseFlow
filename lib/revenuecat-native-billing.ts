import type { Pool } from "pg"
import { nativeBillingEnvironment } from "@/lib/billing-access"
import { applyNativeBillingSnapshot, beginNativeBillingVerification, NativeBillingError,
  type NativeBillingAccount, type VerifiedNativeSubscription } from "@/lib/native-billing-store"

type Json = Record<string, unknown>
type Store = VerifiedNativeSubscription["store"]
export type NativeBillingProduct = { revenuecatProductId: string; storeProductId: string; store: Store; interval: "monthly" | "yearly" }
export type RevenueCatConfig = {
  projectId: string
  environment: NativeBillingAccount["environment"]
  v2Secret: string
  v1Secret: string
  products: NativeBillingProduct[]
}
export class RevenueCatVerificationError extends Error {
  constructor(public code: "configuration" | "response" | "identity" | "pagination" | "request", public providerStatus?: number, public retryAfterSeconds?: number) {
    super(`Store verification failed: ${code}`)
    this.name = "RevenueCatVerificationError"
  }
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RevenueCatVerificationError("response")
  return value as Json
}
function string(value: unknown, max = 255): string {
  if (typeof value !== "string" || !value.length || value.length > max || /[\u0000-\u001f]/.test(value)) throw new RevenueCatVerificationError("response")
  return value
}
function milliseconds(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 8_640_000_000_000_000) throw new RevenueCatVerificationError("response")
  return value
}

export function revenueCatConfig(env: NodeJS.ProcessEnv = process.env): RevenueCatConfig | null {
  const environment = nativeBillingEnvironment(env)
  if (!environment) return null
  try {
    const projectId = string(env.REVENUECAT_PROJECT_ID)
    const v2Secret = string(env.REVENUECAT_V2_SECRET_KEY, 1000), v1Secret = string(env.REVENUECAT_V1_SECRET_KEY, 1000)
    const raw: unknown = JSON.parse(env.REVENUECAT_NATIVE_PRODUCTS ?? "null")
    if (!Array.isArray(raw) || raw.length !== 4) throw new Error("Missing native products")
    const products = raw.map(value => {
      const item = object(value)
      const revenuecatProductId = string(item.revenuecatProductId), storeProductId = string(item.storeProductId)
      if (!["app_store", "play_store"].includes(String(item.store)) || !["monthly", "yearly"].includes(String(item.interval))) throw new Error("Invalid product")
      return { revenuecatProductId, storeProductId, store: item.store as Store, interval: item.interval as NativeBillingProduct["interval"] }
    })
    if (new Set(products.map(item => item.revenuecatProductId)).size !== 4 ||
      new Set(products.map(item => `${item.store}:${item.interval}`)).size !== 4 ||
      new Set(products.map(item => `${item.store}:${item.storeProductId}`)).size !== 4) throw new Error("Duplicate products")
    return { projectId, environment, v2Secret, v1Secret, products }
  } catch { throw new RevenueCatVerificationError("configuration") }
}

/** Provider responses and pagination are untrusted data, even though transport
 * is authenticated. Never forward an API key to a redirect or different URL. */
async function readJson(url: URL, secret: string, signal: AbortSignal, fetcher: typeof fetch) {
  let response: Response
  try { response = await fetcher(url, { method: "GET", headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
    cache: "no-store", redirect: "error", signal }) }
  catch { throw new RevenueCatVerificationError("request") }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("retry-after"))
    throw new RevenueCatVerificationError("request", response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(86400, Math.ceil(retryAfter)) : undefined)
  }
  try { return object(await response.json()) } catch { throw new RevenueCatVerificationError("response") }
}

async function listSubscriptions(account: NativeBillingAccount, config: RevenueCatConfig, signal: AbortSignal, fetcher: typeof fetch) {
  const base = new URL(`https://api.revenuecat.com/v2/projects/${encodeURIComponent(config.projectId)}/customers/${encodeURIComponent(account.id)}/subscriptions`)
  const items: unknown[] = [], seen = new Set<string>()
  let next: URL | null = base
  while (next) {
    if (seen.size >= 20 || next.origin !== base.origin || next.pathname !== base.pathname || next.username || next.password || next.hash ||
      [...next.searchParams.keys()].some(key => !["environment", "limit", "starting_after"].includes(key))) throw new RevenueCatVerificationError("pagination")
    // RevenueCat's next_page can omit the environment filter; reapply it on
    // every request and also validate each returned subscription below.
    next.searchParams.set("environment", config.environment)
    next.searchParams.set("limit", "100")
    if (seen.has(next.href)) throw new RevenueCatVerificationError("pagination")
    seen.add(next.href)
    const page = await readJson(next, config.v2Secret, signal, fetcher)
    if (page.object !== "list" || !Array.isArray(page.items) || page.items.length > 100) throw new RevenueCatVerificationError("response")
    items.push(...page.items)
    if (page.next_page === null || page.next_page === undefined) next = null
    else {
      try { next = new URL(string(page.next_page, 5000), base.origin) }
      catch { throw new RevenueCatVerificationError("pagination") }
    }
  }
  return items
}

/** V2 identifies original ownership and exposes the current access decision.
 * Its schema has no explicit grace expiry. For grace periods only, verify the
 * corresponding V1 subscription's explicit grace deadline, environment, store
 * and transaction. Never turn "gives_access" into an unbounded local grant. */
export async function fetchVerifiedNativeSubscriptions(account: NativeBillingAccount, config: RevenueCatConfig,
  fetcher: typeof fetch = fetch, requestSignal?: AbortSignal): Promise<VerifiedNativeSubscription[]> {
  if (account.project_id !== config.projectId || account.environment !== config.environment) throw new RevenueCatVerificationError("configuration")
  const timeout = AbortSignal.timeout(15_000)
  const signal = requestSignal ? AbortSignal.any([timeout, requestSignal]) : timeout
  const items = await listSubscriptions(account, config, signal, fetcher)
  const verified: VerifiedNativeSubscription[] = [], ids = new Set<string>()
  let legacy: Json | undefined
  for (const value of items) {
    const item = object(value), id = string(item.id)
    if (item.object !== "subscription" || ids.has(id) || item.environment !== config.environment) throw new RevenueCatVerificationError("response")
    ids.add(id)
    // Refuse aliases/transfers and store family-sharing as a source of a second
    // household entitlement. Cyntch itself shares access within the household.
    if (item.customer_id !== account.id || item.original_customer_id !== account.id) throw new RevenueCatVerificationError("identity")
    const product = config.products.find(candidate => candidate.revenuecatProductId === item.product_id)
    if (!product) continue // Other products/promotional grants never unlock Cyntch.
    if (item.store !== product.store || item.ownership !== "purchased" || typeof item.gives_access !== "boolean" || typeof item.pending_payment !== "boolean") throw new RevenueCatVerificationError("response")
    const status = string(item.status, 80), autoRenewalStatus = string(item.auto_renewal_status, 80)
    const end = milliseconds(item.ends_at), periodEnd = milliseconds(item.current_period_ends_at)
    let through = end ?? periodEnd
    if (item.gives_access && status === "in_grace_period") {
      if (!legacy) {
        const result = await readJson(new URL(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(account.id)}`), config.v1Secret, signal, fetcher)
        legacy = object(result.subscriber)
        if (legacy.original_app_user_id !== account.id) throw new RevenueCatVerificationError("identity")
      }
      const match = object(object(legacy.subscriptions)[product.storeProductId])
      if (match.store !== product.store || match.is_sandbox !== (config.environment === "sandbox") ||
        String(match.store_transaction_id) !== string(item.store_subscription_identifier) || match.refunded_at !== null) throw new RevenueCatVerificationError("response")
      const grace = Date.parse(string(match.grace_period_expires_date))
      if (!Number.isFinite(grace)) throw new RevenueCatVerificationError("response")
      through = grace
    }
    if (item.gives_access && through === null) throw new RevenueCatVerificationError("response")
    verified.push({ id, originalCustomerId: account.id, environment: account.environment, store: product.store,
      productId: product.revenuecatProductId, status, autoRenewalStatus, givesAccess: item.gives_access, pendingPayment: item.pending_payment,
      accessThrough: through === null ? null : new Date(through).toISOString() })
  }
  return verified
}

/** No client-supplied purchase/expiry data participates in this path. A failed
 * provider request leaves the previous verified snapshot and expiry intact. */
export async function verifyNativeBillingAccount(pool: Pool, accountId: string, config: RevenueCatConfig, fetcher: typeof fetch = fetch) {
  const account = await beginNativeBillingVerification(pool, accountId)
  if (account.project_id !== config.projectId || account.environment !== config.environment) throw new NativeBillingError("configuration_mismatch")
  const subscriptions = await fetchVerifiedNativeSubscriptions(account, config, fetcher)
  return applyNativeBillingSnapshot(pool, accountId, account.revision, subscriptions)
}
