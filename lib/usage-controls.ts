import { db } from "@/lib/db"
import type { PoolClient } from "pg"
import { EntitlementError } from "@/lib/entitlements"
import type { HouseholdTier } from "@/lib/billing-policy"
import { accountHash, AccountAccessError } from "@/lib/account-access"

/** Atomic fixed-window limits shared across server instances. No task content is recorded. */
export async function enforceRequestLimit(userId:string, operation:"read"|"write"|"billing") {
  const maximum = operation === "billing" ? 6 : operation === "write" ? 120 : 120
  const result = await db.query<{blocked:boolean;allowed:boolean}>(`with access as (
      select exists(select 1 from account_deletion_requests where account_hash=$3) as blocked
    ), allowed as (insert into application_rate_limits (bucket_key,window_start,requests)
    select $1,date_trunc('minute',now()),1 where not (select blocked from access)
    on conflict (bucket_key,window_start) do update
      set requests = application_rate_limits.requests + 1
      where application_rate_limits.requests < $2
    returning requests)
    select blocked,exists(select 1 from allowed) as allowed from access`, [operation + ":" + userId, maximum,accountHash(userId)])
  if (result.rows[0].blocked) throw new AccountAccessError()
  if (!result.rows[0].allowed) throw new EntitlementError("Too many requests. Please wait a minute and retry.",429)
}

export async function recordHouseholdUsage(client:PoolClient, householdId:string, tier:HouseholdTier, milliseconds:number,
  generatedOccurrences=0, generatedTasks=0) {
  await client.query(`insert into household_usage_daily
    (household_id,tier,requests,processing_ms,generated_occurrences,generated_tasks)
    values ($1::uuid,$2,1,$3,$4,$5)
    on conflict (household_id,usage_date,tier) do update set
      requests = household_usage_daily.requests + 1,
      processing_ms = household_usage_daily.processing_ms + excluded.processing_ms,
      generated_occurrences = household_usage_daily.generated_occurrences + excluded.generated_occurrences,
      generated_tasks = household_usage_daily.generated_tasks + excluded.generated_tasks`,
    [householdId,tier,Math.max(0,Math.round(milliseconds)),generatedOccurrences,generatedTasks])
}

export async function recordHouseholdActivity(client:PoolClient, householdId:string) {
  await client.query(`insert into household_billing (household_id,last_activity_at) values ($1::uuid,now())
    on conflict (household_id) do update set last_activity_at=now()
    where household_billing.last_activity_at < now() - interval '1 hour'`,[householdId])
}
