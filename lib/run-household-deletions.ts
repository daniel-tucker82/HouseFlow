import { db } from "@/lib/db"
import { stripeClient } from "@/lib/stripe-billing"
import { processHouseholdDeletions } from "@/lib/household-deletion-processing"
import { SchedulerDeadline, schedulerTransaction } from "@/lib/scheduler-deadline"

/** Accepted cleanup keeps draining when new submissions are disabled. */
export async function runHouseholdDeletions() {
  if (process.env.HOUSEHOLD_DELETION_PROCESSING_ENABLED !== "true") return { enabled: false, ok: true }
  try {
    const key = process.env.STRIPE_SECRET_KEY ?? ""
    if (!/^[sr]k_(live|test)_\S+$/.test(key)) throw new Error("Billing cleanup is not configured")
    const result = await processHouseholdDeletions(db, { client: stripeClient(), livemode: /^[sr]k_live_/.test(key) })
    const health = await schedulerTransaction(db, new SchedulerDeadline(2_000), async client => (await client.query<{ pending: number; failed: number }>(`select count(*)::int as pending,
      count(*) filter(where last_error_code is not null)::int as failed from household_deletion_requests where state='pending'`)).rows[0])
    return { enabled: true, ok: health.failed === 0, ...result, ...health }
  } catch {
    console.error("[household-deletion] Billing cleanup needs retry")
    return { enabled: true, ok: false, error: "Household billing cleanup needs retry" }
  }
}
