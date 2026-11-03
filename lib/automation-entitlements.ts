import type { PoolClient } from "pg"
import { getHouseholdEntitlement } from "@/lib/entitlements"
import { retainedTaskLimit } from "@/lib/billing-policy"

// Trusted SQL fragment: callers join tasks as t. It preserves dependency-only
// progress on downgrade while ignoring saved timing rules without deleting them.
export const TASK_AUTOMATION_ALLOWED_SQL = process.env.FREEMIUM_ENFORCEMENT_ENABLED === "false" ? "true" : `exists (
  select 1 from households eh
  left join owner_entitlements eo on eo.user_id = eh.leader_id
  left join household_billing eb on eb.household_id = eh.id
  where eh.id = t.household_id and (eo.user_id is not null or (
    eb.billing_hold is null and eb.subscription_status in ('active', 'past_due', 'canceled') and eb.paid_through > now()
  ))
)`

export async function occurrenceAutomationAllowed(client: PoolClient, occurrenceId: string) {
  const result = await client.query(`select 1 from tasks t where t.routine_occurrence_id = $1::uuid
    and ${TASK_AUTOMATION_ALLOWED_SQL} limit 1`, [occurrenceId])
  return Boolean(result.rowCount)
}

export async function automaticGenerationAllowance(client: PoolClient, householdId: string) {
  const lock = await client.query("select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired", [householdId])
  if (!lock.rows[0].acquired) return 0
  const entitlement = await getHouseholdEntitlement(client, householdId)
  if (!entitlement.limits.automation) return 0
  const configured = Number(process.env.AUTOMATION_INACTIVE_DAYS ?? 365)
  const days = Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured,3650) : 365
  const activity = await client.query("select last_activity_at < now() - make_interval(days => $2) as inactive from household_billing where household_id = $1::uuid",[householdId,days])
  if (activity.rows[0]?.inactive) return 0
  const count = await client.query("select count(*)::int as n from routine_occurrences where household_id = $1::uuid and status = 'active'", [householdId])
  const stored = await client.query("select count(*)::int as n from tasks where household_id=$1::uuid",[householdId])
  const remainingRuns = Math.floor((retainedTaskLimit(entitlement.tier,process.env)-stored.rows[0].n)/entitlement.limits.items)
  return Math.max(0, Math.min(10, entitlement.limits.activeExecutions - count.rows[0].n,remainingRuns))
}
