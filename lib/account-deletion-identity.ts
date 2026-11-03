import type { Pool } from "pg"
import { accountHash } from "@/lib/account-access"
import { AccountDeletionDeferred, AccountDeletionProcessingError, type AccountDeletionJob } from "@/lib/account-deletion-processing"
import type { AccountDeletionWork } from "@/lib/account-deletion-requests"
import { revokeAccountAppleIdentity, type AppleExternalAccount, type AppleRevocationConfig } from "@/lib/account-deletion-apple"

type Json = Record<string, unknown>
type Provider = { secretKey: string; fetcher?: typeof fetch; apple?: AppleRevocationConfig }
const failed = () => new AccountDeletionProcessingError("identity_cleanup_failed")
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failed()
  return value as Json
}
/** The caller supplies the issuer from Clerk's verified session claims, never
 * the request body. It is recorded before those sessions can be destroyed. */
export function accountDeletionIssuer(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && !url.port && url.pathname === "/" && !url.search && !url.hash &&
      (value === url.origin || value === `${url.origin}/`) ? url.origin : null
  } catch { return null }
}

/** Final internal deletion phase. Verifies the Clerk instance associated with
 * the accepted authenticated session before interpreting a user-level 404.
 * Uses the REST API directly for bounded requests (the installed SDK doesn't
 * expose a per-request AbortSignal). Apple revocation credentials are encrypted
 * temporarily for interruption recovery and removed after acknowledgement. */
export async function deleteAccountIdentity(pool: Pool, job: AccountDeletionJob, provider?: Provider,
  budgetMs = 20_000, now = () => performance.now()) {
  if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 40_000) throw failed()
  const deadline = now() + budgetMs
  const current = async () => {
    const row = (await pool.query<{ account_id: string | null; account_hash: string; work: AccountDeletionWork; state: string; current: boolean }>(`select *,
      lease_id=$2 and lease_until>clock_timestamp() as current from account_deletion_requests where id=$1`, [job.id, job.leaseId])).rows[0]
    if (!row || row.account_hash !== accountHash(job.accountId)) throw failed()
    if (row.state === "completed" || row.work.phases.identity) return null
    if (row.state !== "pending" || row.account_id !== job.accountId || !row.current || !row.work.phases.data || !row.work.phases.stripe || !row.work.phases.native ||
      !row.work.identity || !accountDeletionIssuer(row.work.identity.issuer)) throw failed()
    return row.work.identity
  }
  try {
    const identity = await current()
    if (!identity || identity.completed) return
    const selected = provider ?? { secretKey: process.env.CLERK_SECRET_KEY ?? "" }
    if (!/^sk_(test|live)_\S{1,1000}$/.test(selected.secretKey)) throw failed()
    const environment = selected.secretKey.startsWith("sk_test_") ? "development" : "production"
    const fetcher = selected.fetcher ?? fetch
    const signal = async () => {
      if (!await current()) throw failed()
      const remaining = Math.floor(deadline - now())
      if (remaining < 1) throw new AccountDeletionDeferred(1)
      return AbortSignal.timeout(Math.min(8_000, remaining))
    }
    const request = async (path: string, method: "GET" | "DELETE" = "GET", missing = false, tokenRequest = false): Promise<Json | null> => {
      const response = await fetcher(`https://api.clerk.com/v1${path}`, { method,
        headers: { Authorization: `Bearer ${selected.secretKey}`, Accept: "application/json", "Clerk-API-Version": "2026-08-20" },
        redirect: "error", cache: "no-store", signal: await signal() })
      const body = object(await response.json())
      if (missing && response.status === 404 && Array.isArray(body.errors) && body.errors.length === 1 && object(body.errors[0]).code === "resource_not_found") return null
      if (tokenRequest && [400,422].includes(response.status) && Array.isArray(body.errors) && body.errors.length === 1 &&
        ["oauth_shared_credentials_token_retrieval_not_supported", "oauth_shared_credentials_stored_token_not_retrievable"].includes(String(object(body.errors[0]).code))) return null
      if (response.status !== 200) throw failed()
      return body
    }
    const instance = await request("/instance")
    if (instance?.object !== "instance" || typeof instance.id !== "string" || !/^ins_[A-Za-z0-9_-]{1,200}$/.test(instance.id) || instance.environment_type !== environment) throw failed()
    if (identity.instanceId) {
      if (instance.id !== identity.instanceId || identity.environment !== environment) throw failed()
    } else {
      const domains = await request("/domains")
      if (!domains || !Array.isArray(domains.data) || !Number.isSafeInteger(domains.total_count) || domains.total_count !== domains.data.length ||
        !domains.data.some(value => { const domain = object(value); return domain.object === "domain" && accountDeletionIssuer(domain.frontend_api_url) === identity.issuer })) throw failed()
      const saved = await pool.query(`update account_deletion_requests set work=jsonb_set(work,'{identity}',work->'identity'||$4::jsonb)
        where id=$1 and account_hash=$2 and lease_id=$3 and lease_until>clock_timestamp() and state='pending'`,
      [job.id, accountHash(job.accountId), job.leaseId, JSON.stringify({ instanceId: instance.id, environment })])
      if (!saved.rowCount) throw failed()
    }
    const path = `/users/${encodeURIComponent(job.accountId)}`
    const appleAccounts = (user: Json | null) => {
      if (!user) return []
      if (user.object !== "user" || user.id !== job.accountId || !Array.isArray(user.external_accounts)) throw failed()
      const accounts: AppleExternalAccount[] = []
      for (const value of user.external_accounts) {
        const external = object(value)
        if (typeof external.provider !== "string" || !external.provider) throw failed()
        if (["apple", "oauth_apple"].includes(external.provider)) {
          if (typeof external.id !== "string" || typeof external.provider_user_id !== "string") throw failed()
          accounts.push({ id: external.id, providerUserId: external.provider_user_id })
        }
      }
      return accounts
    }
    let user = await request(path, "GET", true)
    const accounts = appleAccounts(user), savedIdentity = await current()
    if (!savedIdentity) throw failed()
    if (accounts.length || savedIdentity.appleRevocations?.length) {
      const records = await revokeAccountAppleIdentity({ requestId: job.id, accountId: job.accountId, instanceId: String(instance.id),
        records: savedIdentity.appleRevocations ?? [], accounts, userExists: Boolean(user), config: selected.apple, fetcher, signal,
        tokens: async () => {
          const tokens: Json[] = []
          let total: number | undefined
          do {
            const page = await request(`${path}/oauth_access_tokens/oauth_apple?paginated=true&limit=100&offset=${tokens.length}`, "GET", true, true)
            if (!page) return null
            if (!Array.isArray(page.data) || !Number.isSafeInteger(page.total_count) || Number(page.total_count) < 0 || Number(page.total_count) > 2000 ||
              page.data.length > 100 || (total !== undefined && total !== page.total_count)) throw failed()
            total = Number(page.total_count)
            if ((!page.data.length && tokens.length < total) || tokens.length + page.data.length > total) throw failed()
            tokens.push(...page.data.map(object))
          } while (tokens.length < total)
          return tokens
        },
        save: async records => {
          const saved = await pool.query(`update account_deletion_requests set work=jsonb_set(work,'{identity,appleRevocations}',$4::jsonb),
            apple_revocation_required=apple_revocation_required or $5 where id=$1 and account_hash=$2 and lease_id=$3
            and lease_until>clock_timestamp() and state='pending'`,
          [job.id, accountHash(job.accountId), job.leaseId, JSON.stringify(records), records.some(record => record.status === "manual")])
          if (!saved.rowCount) throw failed()
        },
      })
      user = await request(path, "GET", true)
      if (appleAccounts(user).some(account => !records.some(record => record.externalId === account.id && record.status !== "pending"))) throw new AccountDeletionDeferred(1)
    }
    if (user) {
      const deleted = await request(path, "DELETE", true)
      if (deleted && (deleted.object !== "user" || deleted.id !== job.accountId || deleted.deleted !== true)) throw failed()
      // Never infer final success from a response to a mutation. This also
      // recovers a successful DELETE whose response was lost on a later visit.
      const remaining = await request(path, "GET", true)
      if (remaining) {
        if (remaining.object !== "user" || remaining.id !== job.accountId) throw failed()
        throw new AccountDeletionDeferred(5)
      }
    }
    const saved = await pool.query(`update account_deletion_requests set work=jsonb_set(work,'{identity,completed}','true'::jsonb)
      where id=$1 and account_hash=$2 and account_id=$3 and lease_id=$4 and lease_until>clock_timestamp() and state='pending'`,
    [job.id, accountHash(job.accountId), job.accountId, job.leaseId])
    if (!saved.rowCount) throw failed()
  } catch (error) {
    if (error instanceof AccountDeletionDeferred) throw error
    throw failed()
  }
}
