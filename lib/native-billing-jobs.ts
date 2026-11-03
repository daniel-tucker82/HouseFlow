import { randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { applyNativeBillingSnapshot, NativeBillingError, type NativeBillingAccount } from "@/lib/native-billing-store"
import { fetchVerifiedNativeSubscriptions, RevenueCatVerificationError, type RevenueCatConfig } from "@/lib/revenuecat-native-billing"

/** Use in the same transaction as receipt acceptance or an authorised billing
 * action. A new event never clears an active lease or a retry's attempt count. */
export async function enqueueNativeBillingAccount(client: Pick<PoolClient, "query">, accountId: string) {
  await client.query(`insert into native_billing_jobs(account_id) values($1::uuid)
    on conflict(account_id) do update set requested_generation=native_billing_jobs.requested_generation+1,
      next_attempt_at=case when native_billing_jobs.last_error_code is not null and native_billing_jobs.next_attempt_at>now()
        then native_billing_jobs.next_attempt_at else least(coalesce(native_billing_jobs.next_attempt_at,now()),now()) end,updated_at=now()`, [accountId])
}

export type NativeBillingJob = NativeBillingAccount & { revision: string; generation: string; leaseId: string; attempts: number }

export async function claimNativeBillingJob(pool: Pool, config: Pick<RevenueCatConfig, "projectId" | "environment">): Promise<NativeBillingJob | null> {
  const client = await pool.connect()
  try {
    await client.query("begin")
    await client.query("set local statement_timeout='5s'")
    const row = (await client.query<NativeBillingAccount & { requested_generation: string; attempts: number }>(`select a.id,a.household_id,a.project_id,a.environment,j.requested_generation,j.attempts
      from native_billing_jobs j join native_billing_accounts a on a.id=j.account_id
      where a.project_id=$1 and a.environment=$2 and j.next_attempt_at<=now()
        and (j.lease_until is null or j.lease_until<=now())
      order by j.next_attempt_at,j.account_id limit 1 for update of a,j skip locked`, [config.projectId, config.environment])).rows[0]
    if (!row) { await client.query("commit"); return null }
    const leaseId = randomUUID()
    await client.query(`update native_billing_jobs set lease_id=$2::uuid,lease_until=now()+interval '60 seconds',
      attempts=attempts+1,updated_at=now() where account_id=$1::uuid`, [row.id, leaseId])
    // Reserve the response ordering before leaving the lease transaction. A
    // stalled old worker cannot reserve a newer revision after lease takeover.
    const attempt = (await client.query<{ revision: string; household_id: string | null }>(`update native_billing_accounts
      set requested_revision=requested_revision+1 where id=$1::uuid returning requested_revision::text as revision,household_id`, [row.id])).rows[0]
    await client.query("commit")
    return { ...row, household_id: attempt.household_id, revision: attempt.revision, generation: row.requested_generation, leaseId, attempts: row.attempts + 1 }
  } catch (error) { await client.query("rollback"); throw error }
  finally { client.release() }
}

export async function finishNativeBillingJob(pool: Pick<Pool, "query">, job: NativeBillingJob,
  result: { kind: "success"; nextCheckSeconds: number } | { kind: "retry"; code: string; retrySeconds: number } | { kind: "retired" }) {
  const retry = result.kind === "retry"
  const delay = result.kind === "success" ? result.nextCheckSeconds : retry ? result.retrySeconds : 0
  const completed = await pool.query(`update native_billing_jobs set
    completed_generation=case when $3 then completed_generation else greatest(completed_generation,$4::bigint) end,
    next_attempt_at=case when $5 then null
      when requested_generation>$4::bigint and not $3 then now() else now()+$6*interval '1 second' end,
    attempts=case when $3 then attempts else 0 end,last_error_code=$7,
    last_completed_at=case when $3 then last_completed_at else now() end,
    lease_id=null,lease_until=null,updated_at=now()
    where account_id=$1::uuid and lease_id=$2::uuid`,
  [job.id,job.leaseId,retry,job.generation,result.kind === "retired",Math.max(1,Math.min(86400,Math.ceil(delay))),retry ? result.code : null])
  return Boolean(completed.rowCount)
}

function retryReason(error: unknown) {
  if (error instanceof RevenueCatVerificationError) return `provider_${error.code}${error.providerStatus ? `_${error.providerStatus}` : ""}`
  if (error instanceof NativeBillingError) return error.code
  return "verification_failed"
}

export async function nativeBillingJobHealth(pool: Pick<Pool, "query">, config: Pick<RevenueCatConfig, "projectId" | "environment">) {
  const row = (await pool.query<{ due: number; failed: number; oldest_due_seconds: number; maximum_attempts: number }>(`select
    count(*) filter(where j.next_attempt_at<=now())::int as due,
    count(*) filter(where j.last_error_code is not null)::int as failed,
    coalesce(greatest(0,extract(epoch from now()-min(j.next_attempt_at))),0)::int as oldest_due_seconds,
    coalesce(max(j.attempts),0)::int as maximum_attempts
    from native_billing_jobs j join native_billing_accounts a on a.id=j.account_id
    where a.project_id=$1 and a.environment=$2 and j.next_attempt_at is not null`, [config.projectId,config.environment])).rows[0]
  return { due: row.due, failed: row.failed, oldestDueSeconds: row.oldest_due_seconds, maximumAttempts: row.maximum_attempts }
}

/** Bounded worker; only leases live in memory. Everything needed for retry and
 * periodic recovery survives a process exit. */
export async function processNativeBillingJobs(pool: Pool, config: RevenueCatConfig,
  options: { limit?: number; deadline?: number; fetcher?: typeof fetch } = {}) {
  const deadline = options.deadline ?? Date.now() + 20_000
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 5)))
  let claimed = 0, verified = 0, retried = 0, retired = 0, superseded = 0
  while (claimed < limit && Date.now() + 1000 < deadline) {
    const job = await claimNativeBillingJob(pool, config)
    if (!job) break
    claimed++
    try {
      if (!job.household_id) {
        await finishNativeBillingJob(pool, job, { kind: "retired" }); retired++; continue
      }
      const signal = AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now())))
      const subscriptions = await fetchVerifiedNativeSubscriptions(job, config, options.fetcher ?? fetch, signal)
      const result = await applyNativeBillingSnapshot(pool, job.id, job.revision, subscriptions)
      if (!result.applied) superseded++
      // Recheck paid access hourly, more often during billing trouble and near
      // expiry. Empty/fully expired accounts get a daily missed-event check.
      let nextCheckSeconds = subscriptions.some(item => item.givesAccess) ? 3600 : 86400
      for (const item of subscriptions) {
        if (["in_grace_period", "in_billing_retry", "incomplete"].includes(item.status)) nextCheckSeconds = Math.min(nextCheckSeconds, 300)
        const expiry = item.accessThrough ? Date.parse(item.accessThrough) : 0
        if (item.givesAccess && expiry > Date.now()) nextCheckSeconds = Math.min(nextCheckSeconds, Math.max(30, (expiry - Date.now()) / 1000 + 5))
      }
      if (await finishNativeBillingJob(pool, job, { kind: "success", nextCheckSeconds: result.applied ? nextCheckSeconds : 30 })) verified++
    } catch (error) {
      if (error instanceof NativeBillingError && error.code === "account_retired") {
        await finishNativeBillingJob(pool, job, { kind: "retired" }); retired++; continue
      }
      const backoff = Math.min(3600, 30 * 2 ** Math.min(7, Math.max(0, job.attempts - 1)))
      const retrySeconds = error instanceof RevenueCatVerificationError ? Math.max(backoff, error.retryAfterSeconds ?? 0) : backoff
      await finishNativeBillingJob(pool, job, { kind: "retry", code: retryReason(error), retrySeconds })
      retried++
    }
  }
  const health = await nativeBillingJobHealth(pool, config)
  return { ok: retried === 0 && health.failed === 0 && health.oldestDueSeconds <= 300, claimed, verified, retried, retired, superseded, health }
}
