import type { Pool } from "pg"
import { accountHash } from "@/lib/account-access"
import { AccountDeletionDeferred, AccountDeletionProcessingError, type AccountDeletionJob } from "@/lib/account-deletion-processing"
import type { AccountDeletionWork } from "@/lib/account-deletion-requests"

type Json = Record<string, unknown>
type RetiredAccount = AccountDeletionWork["retiredNativeAccounts"][number]
type Provider = { projectId: string; secret: string; fetcher?: typeof fetch }
const failed = () => new AccountDeletionProcessingError("native_cleanup_failed")
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failed()
  return value as Json
}
function text(value: unknown, maximum = 255): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u0020\u007f]/.test(value)
}
function configured(): Provider {
  // Erasure must remain available when new purchases are disabled. It does
  // not need a V1 key, SDK key or the current product catalogue.
  return { projectId: process.env.REVENUECAT_PROJECT_ID ?? "", secret: process.env.REVENUECAT_V2_SECRET_KEY ?? "" }
}

/** Only for the captured identities of deleted households. Transferred/shared
 * households keep their opaque billing identity. RevenueCat deletion does not
 * cancel Apple/Google subscriptions, and this adapter never claims it does.
 *
 * V2 DELETE queues erasure; only V2 GET/404 confirms it. V1 Get-or-Create must
 * never be used here. All acknowledgements and waits survive process death.
 * Existing local purchase bindings remain intact for restore protection.
 * This is internal until the complete account-deletion workflow is ready. */
export async function deleteAccountNativeData(pool: Pool, job: AccountDeletionJob, provider?: Provider,
  budgetMs = 20_000, now = () => performance.now()) {
  if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 40_000) throw failed()
  const deadline = now() + budgetMs
  const current = async () => {
    const row = (await pool.query<{ account_id: string | null; account_hash: string; work: AccountDeletionWork; state: string; current: boolean }>(`select *,
      lease_id=$2 and lease_until>clock_timestamp() as current from account_deletion_requests where id=$1`, [job.id, job.leaseId])).rows[0]
    if (!row || row.account_hash !== accountHash(job.accountId)) throw failed()
    if (row.state === "completed" || row.work.phases.native) return null
    if (row.state !== "pending" || row.account_id !== job.accountId || !row.current || !row.work.phases.data || !row.work.phases.stripe ||
      !Array.isArray(row.work.retiredNativeAccounts)) throw failed()
    return row.work
  }
  const retired = async (item: RetiredAccount) => {
    const work = await current()
    if (!work?.retiredNativeAccounts.some(saved => saved.id === item.id && saved.projectId === item.projectId && saved.environment === item.environment)) throw failed()
    const row = (await pool.query("select household_id,project_id,environment from native_billing_accounts where id=$1::uuid", [item.id])).rows[0]
    if (!row || row.household_id !== null || row.project_id !== item.projectId || row.environment !== item.environment) throw failed()
  }
  const save = async (index: number, field: "requestedAt" | "completed", value: string | boolean) => {
    const saved = await pool.query(`update account_deletion_requests set work=jsonb_set(work,array['retiredNativeAccounts',$4,$5],$6::jsonb)
      where id=$1 and account_hash=$2 and account_id=$3 and lease_id=$7 and lease_until>clock_timestamp() and state='pending'`,
    [job.id, accountHash(job.accountId), job.accountId, String(index), field, JSON.stringify(value), job.leaseId])
    if (!saved.rowCount) throw failed()
  }
  try {
    const work = await current()
    if (!work || work.retiredNativeAccounts.every(item => item.completed)) return
    const selected = provider ?? configured()
    if (!text(selected.projectId) || !text(selected.secret, 1000) || work.retiredNativeAccounts.some(item => item.projectId !== selected.projectId)) throw failed()
    const base = new URL(`https://api.revenuecat.com/v2/projects/${encodeURIComponent(selected.projectId)}/customers`)
    const fetcher = selected.fetcher ?? fetch
    const request = async (url: URL, method: "GET" | "DELETE", item?: RetiredAccount, missing = false): Promise<Json | null> => {
      if (item) await retired(item)
      else if (!await current()) throw failed()
      const remaining = Math.floor(deadline - now())
      if (remaining < 1) throw new AccountDeletionDeferred(1)
      const response = await fetcher(url, { method, headers: { Authorization: `Bearer ${selected.secret}`, Accept: "application/json" },
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(Math.min(8_000, remaining)) })
      const body = object(await response.json())
      // An HTML/proxy 404, invalid project or failed permission check is not
      // evidence that personal data has been erased.
      if (missing && response.status === 404 && body.object === "error" && body.type === "resource_missing" &&
        (body.param === undefined || body.param === null || body.param === "customer_id")) return null
      if (response.status !== 200) throw failed()
      return body
    }
    const page = (value: Json | null, maximum: number) => {
      if (!value || value.object !== "list" || !Array.isArray(value.items) || value.items.length > maximum ||
        !(value.next_page === null || typeof value.next_page === "string")) throw failed()
      return value.items.map(object)
    }
    // Prove access to the exact project using the same customer-read scope
    // before interpreting any customer-level 404. Do not retain other users.
    const access = await request(new URL(`${base.href}?limit=1`), "GET")
    for (const customer of page(access, 1)) {
      if (customer.object !== "customer" || customer.project_id !== selected.projectId || !text(customer.id, 1500)) throw failed()
    }
    let pending = false
    for (let index = 0; index < work.retiredNativeAccounts.length; index++) {
      const item = work.retiredNativeAccounts[index]
      if (item.completed) continue
      const customerUrl = new URL(`${base.href}/${encodeURIComponent(item.id)}`)
      const customer = await request(customerUrl, "GET", item, true)
      if (!customer) {
        await retired(item)
        await save(index, "completed", true)
        continue
      }
      if (customer.object !== "customer" || customer.id !== item.id || customer.project_id !== item.projectId) throw failed()
      if (item.requestedAt !== undefined) {
        const queued = Date.parse(item.requestedAt)
        if (!Number.isFinite(queued)) throw failed()
        // Usually just poll once per job. Revalidate and reissue after five
        // minutes if the provider still has it, including a recreated record.
        if (Date.now() - queued < 300_000) { pending = true; continue }
      }
      for (const resource of ["aliases", "subscriptions", "purchases"] as const) {
        const resourceUrl = new URL(`${customerUrl.href}/${resource}`), seen = new Set<string>()
        let next: URL | null = resourceUrl
        while (next) {
          if (next.origin !== resourceUrl.origin || next.pathname !== resourceUrl.pathname || next.username || next.password || next.hash ||
            [...next.searchParams.keys()].some(key => !["limit", "starting_after"].includes(key))) throw failed()
          next.searchParams.set("limit", "100")
          if (seen.size >= 20 || seen.has(next.href)) throw failed()
          seen.add(next.href)
          const result = await request(next, "GET", item)
          for (const value of page(result, 100)) {
            // Identified SDK setup never aliases billing identities. Refuse
            // unexpected aliases rather than erase another household's data.
            if (resource === "aliases") {
              if (value.object !== "customer.alias" || value.id !== item.id) throw failed()
            } else if (value.object !== (resource === "subscriptions" ? "subscription" : "purchase") || !text(value.id) ||
              value.customer_id !== item.id || value.original_customer_id !== item.id || value.environment !== item.environment ||
              !["app_store", "play_store"].includes(String(value.store)) || value.ownership !== "purchased") throw failed()
          }
          // No environment filter: deletion erases sandbox AND production.
          // Inspect all returned data to detect mixed or foreign ownership.
          next = result!.next_page === null ? null : new URL(String(result!.next_page), base.origin)
        }
      }
      const deleted = await request(customerUrl, "DELETE", item, true)
      if (deleted && (deleted.object !== "customer" || deleted.id !== item.id || typeof deleted.deleted_at !== "number" ||
        !Number.isSafeInteger(deleted.deleted_at) || deleted.deleted_at <= 0)) throw failed()
      // Even DELETE/404 is confirmed through GET on the next durable visit.
      await save(index, "requestedAt", new Date().toISOString())
      pending = true
    }
    if (pending) throw new AccountDeletionDeferred(5)
  } catch (error) {
    if (error instanceof AccountDeletionDeferred) throw error
    // Provider error messages can include private identifiers and API keys.
    throw failed()
  }
}
