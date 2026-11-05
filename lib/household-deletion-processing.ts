import { randomUUID } from "node:crypto"
import type { Pool } from "pg"
import type Stripe from "stripe"
import { SchedulerDeadline, schedulerTransaction } from "@/lib/scheduler-deadline"

interface Job { id: string; household_id: string; stripe_customer_id: string | null; stripe_subscription_id: string | null; stripe_livemode: boolean; lease_id: string }
type Provider = { client: Stripe; livemode: boolean }
const failed = () => new Error("Household billing cleanup needs retry")

export async function processHouseholdDeletions(pool: Pool, provider: Provider, budgetMs = 20_000) {
  if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 25_000) throw failed()
  const deadline = new SchedulerDeadline(budgetMs)
  let completed = 0, retried = 0
  for (let index = 0; index < 5 && deadline.remaining() > 500; index++) {
    const job = await schedulerTransaction(pool, deadline, async client => (await client.query<Job>(`update household_deletion_requests set
      lease_id=$1,lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1
      where id=(select id from household_deletion_requests where state='pending' and next_attempt_at<=now()
        and (lease_until is null or lease_until<clock_timestamp()) order by next_attempt_at,id for update skip locked limit 1) returning *`, [randomUUID()])).rows[0])
    if (!job) break
    const options = async () => {
      await schedulerTransaction(pool, deadline, async client => {
        if (!(await client.query("select 1 from household_deletion_requests where id=$1 and state='pending' and lease_id=$2 and lease_until>clock_timestamp()", [job.id, job.lease_id])).rowCount) throw failed()
        if ((await client.query("select 1 from households where id=$1", [job.household_id])).rowCount) throw failed()
        if ((await client.query(`select 1 from household_billing where stripe_customer_id=$1 or stripe_subscription_id=$2`, [job.stripe_customer_id, job.stripe_subscription_id])).rowCount) throw failed()
      })
      deadline.assertActive()
      return { timeout: Math.min(8_000, deadline.remaining()), maxNetworkRetries: 0 }
    }
    try {
      if (provider.livemode !== job.stripe_livemode) throw failed()
      let customerId = job.stripe_customer_id
      if (!customerId && job.stripe_subscription_id) {
        const requestOptions = await options()
        const subscription = await deadline.run(() => provider.client.subscriptions.retrieve(job.stripe_subscription_id!, {}, requestOptions))
        if (subscription.id !== job.stripe_subscription_id || subscription.livemode !== job.stripe_livemode || subscription.metadata.app !== "cyntch" || subscription.metadata.household_id !== job.household_id) throw failed()
        customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id
        // Persist discovery before mutation; retries must not depend on a subscription that was subsequently cancelled.
        await schedulerTransaction(pool, deadline, async client => {
          if (!(await client.query(`update household_deletion_requests set stripe_customer_id=$3 where id=$1 and lease_id=$2
            and state='pending' and lease_until>clock_timestamp()`, [job.id, job.lease_id, customerId])).rowCount) throw failed()
        })
        job.stripe_customer_id = customerId
      }
      if (!customerId || !/^cus_[A-Za-z0-9_]+$/.test(customerId)) throw failed()
      const retrieveOptions = await options()
      const customer = await deadline.run(() => provider.client.customers.retrieve(customerId, {}, retrieveOptions))
      if (customer.id !== customerId) throw failed()
      if (!customer.deleted) {
        if (customer.livemode !== job.stripe_livemode || customer.metadata.app !== "cyntch" || customer.metadata.household_id !== job.household_id) throw failed()
        const deleteOptions = await options()
        const removed = await deadline.run(() => provider.client.customers.del(customerId, {}, deleteOptions))
        if (removed.id !== customerId || removed.deleted !== true) throw failed()
      }
      // A lost DELETE response is recovered by retrieve(deleted=true), never by treating arbitrary 404s as success.
      await schedulerTransaction(pool, deadline, async client => {
        if (!(await client.query(`update household_deletion_requests set state='completed',completed_at=clock_timestamp(),
          stripe_customer_id=null,stripe_subscription_id=null,stripe_livemode=null,next_attempt_at=null,lease_id=null,lease_until=null,last_error_code=null
          where id=$1 and lease_id=$2 and state='pending' and lease_until>clock_timestamp()`, [job.id, job.lease_id])).rowCount) throw failed()
      })
      completed++
    } catch {
      retried++
      if (deadline.remaining() < 1) break // The retained lease recovers after interruption or budget expiry.
      await schedulerTransaction(pool, deadline, async client => {
        await client.query(`update household_deletion_requests set lease_id=null,lease_until=null,next_attempt_at=now()+interval '1 minute',
          last_error_code='stripe_cleanup_failed' where id=$1 and lease_id=$2 and state='pending'`, [job.id, job.lease_id])
      })
    }
  }
  return { completed, retried }
}
