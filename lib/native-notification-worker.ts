import { randomUUID } from "node:crypto"
import type { Pool } from "pg"
import { claimNativeNotificationDeliveries, expandNativeNotificationEvents, type ClaimedNativeDelivery } from "@/lib/native-notification-outbox"
import { PushProviderError, type ExpoPushResult, type NativePushProvider } from "@/lib/expo-push-provider"
import { SchedulerDeadline, schedulerTransaction } from "@/lib/scheduler-deadline"

function retrySeconds(attempt: number) { return Math.min(3600, 30 * 2 ** Math.min(7, Math.max(0, attempt - 1))) }
function providerFailure(error: unknown) {
  return error instanceof PushProviderError ? error : new PushProviderError("ProviderUnavailable", true)
}
function terminal(code: string) { return ["DeviceNotRegistered", "MessageTooBig", "RequestRejected"].includes(code) }

/** A delayed sender cannot overwrite the result of a newer lease. */
async function finishSend(pool: Pool, job: ClaimedNativeDelivery, response: ExpoPushResult, deadline: SchedulerDeadline) {
  return schedulerTransaction(pool, deadline, async client => {
    const row = (await client.query<{ attempts: number }>("select attempts from native_notification_deliveries where id=$1 and lease_id=$2 and state='sending' for update", [job.id, job.leaseId])).rows[0]
    if (!row) return
    if (response.status === "ok") {
      await client.query(`update native_notification_deliveries set state='awaiting_receipt',ticket_id=$2,accepted_at=now(),
        next_attempt_at=now()+interval '15 minutes',lease_id=null,lease_until=null,last_error_code=null where id=$1`, [job.id, response.id])
    } else {
      const failed = terminal(response.code)
      await client.query(`update native_notification_deliveries set state=$2,last_error_code=$3,lease_id=null,lease_until=null,
        next_attempt_at=now()+$4*interval '1 second',completed_at=case when $5 then now() else null end where id=$1`,
      [job.id, failed ? "failed" : "queued", response.code, retrySeconds(row.attempts), failed])
      if (response.code === "DeviceNotRegistered") await client.query(`update native_notification_devices set expo_push_token=null,revision=revision+1,updated_at=now()
        where user_id=$1 and expo_push_token=$2 and session_id=$3`, [job.message.data.accountId, job.message.to, job.message.data.sessionId])
    }
  })
}

/** Ticket acceptance is not delivery. Receipt polling never resends an accepted ticket. */
export async function checkNativePushReceipts(pool: Pool, provider: NativePushProvider, limit = 100, deadline = new SchedulerDeadline(25_000)) {
  const lease = randomUUID()
  const jobs = await schedulerTransaction(pool, deadline, async client => (await client.query<{ id: string; ticket_id: string; accepted_at: Date; receipt_attempts: number }>(`with due as (
      select id from native_notification_deliveries where state='awaiting_receipt' and next_attempt_at<=now()
        and (lease_until is null or lease_until<=now()) order by next_attempt_at,id limit $1 for update skip locked
    ) update native_notification_deliveries d set lease_id=$2,lease_until=now()+interval '60 seconds',receipt_attempts=receipt_attempts+1
      from due where d.id=due.id returning d.id,d.ticket_id,d.accepted_at,d.receipt_attempts`, [Math.max(1, Math.min(1000, Math.floor(limit))), lease])).rows)
  if (!jobs.length) return 0
  let receipts: Record<string, ExpoPushResult>
  try { receipts = await deadline.run(() => provider.receipts(jobs.map(job => job.ticket_id))) }
  catch (error) {
    const code = providerFailure(error).code
    await schedulerTransaction(pool, deadline, client => client.query(`update native_notification_deliveries set lease_id=null,lease_until=null,
      state=case when accepted_at<now()-interval '24 hours' then 'failed' else state end,
      completed_at=case when accepted_at<now()-interval '24 hours' then now() else null end,
      last_error_code=case when accepted_at<now()-interval '24 hours' then 'ReceiptUnavailable' else $2 end,next_attempt_at=now()+interval '5 minutes'
      where lease_id=$1 and state='awaiting_receipt'`, [lease, code]))
    return jobs.length
  }
  for (const job of jobs) {
    const response = receipts[job.ticket_id]
    await schedulerTransaction(pool, deadline, async client => {
      const current = (await client.query<{ token_hash: string; user_id: string; device_id: string; session_id: string | null; expired: boolean }>(`select token_hash,user_id,device_id,session_id,
        accepted_at<now()-interval '24 hours' as expired from native_notification_deliveries
        where id=$1 and lease_id=$2 and state='awaiting_receipt' for update`, [job.id, lease])).rows[0]
      if (!current) return
      const state = response?.status === "ok" ? "provider_accepted"
        : response?.status === "error" ? (terminal(response.code) ? "failed" : "queued")
          : current.expired ? "failed" : "awaiting_receipt"
      const code = response?.status === "error" ? response.code : !response && current.expired ? "ReceiptUnavailable" : null
      await client.query(`update native_notification_deliveries set state=$3,last_error_code=$4,lease_id=null,lease_until=null,
        next_attempt_at=now()+interval '5 minutes',completed_at=case when $3 in ('provider_accepted','failed') then now() else null end,
        ticket_id=case when $3='queued' then null else ticket_id end where id=$1 and lease_id=$2`, [job.id, lease, state, code])
      if (code === "DeviceNotRegistered") {
        // Expo tokens can stay the same across logins. Match both token and session.
        await client.query(`update native_notification_devices set expo_push_token=null,revision=revision+1,updated_at=now()
          where user_id=$1 and device_id=$2 and encode(sha256(convert_to(expo_push_token,'UTF8')),'hex')=$3 and session_id=$4`, [current.user_id, current.device_id, current.token_hash, current.session_id])
      }
    })
  }
  return jobs.length
}

/** Bounded invocation; persistent rows, leases and backoff carry unfinished work. */
export async function processNativeNotifications(pool: Pool, provider: NativePushProvider, options: { limit?: number; deadline?: number } = {}) {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)))
  // Convert the optional wall-clock deadline once. SQL, pool waits and all
  // phases share one monotonic budget; moving to a new phase never renews it.
  const budget = options.deadline === undefined ? 25_000 : options.deadline - Date.now()
  if (!Number.isFinite(budget)) throw new Error("Invalid native notification deadline")
  const deadline = new SchedulerDeadline(Math.min(25_000, budget))
  if (deadline.remaining() < 1) return { expanded: 0, queued: 0, sendAttempts: 0, receipts: 0 }
  const expanded = await expandNativeNotificationEvents(pool, limit, deadline)
  let receiptCount = 0
  if (deadline.remaining() > 9_000) receiptCount = await checkNativePushReceipts(pool, provider, limit, deadline)
  if (deadline.remaining() <= 9_000) return { ...expanded, sendAttempts: 0, receipts: receiptCount }
  const jobs = await claimNativeNotificationDeliveries(pool, limit, deadline)
  if (!jobs.length) return { ...expanded, sendAttempts: 0, receipts: receiptCount }
  // A slow claim can use the send reserve. Its durable leases expire for retry;
  // never start provider I/O after the remaining budget has become too small.
  if (deadline.remaining() <= 9_000) return { ...expanded, sendAttempts: 0, receipts: receiptCount }
  let results: ExpoPushResult[]
  try { results = await deadline.run(() => provider.send(jobs.map(job => job.message))) }
  catch (error) {
    const failure = providerFailure(error)
    results = jobs.map(() => ({ status: "error", code: failure.retryable ? failure.code : "RequestRejected" }))
  }
  for (let index = 0; index < jobs.length; index++) await finishSend(pool, jobs[index], results[index] ?? { status: "error", code: "InvalidResponse" }, deadline)
  return { ...expanded, sendAttempts: jobs.length, receipts: receiptCount }
}
