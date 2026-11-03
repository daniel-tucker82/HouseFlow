const { Client } = require('pg')

// Explicit credentials only; never load a production environment file implicitly.
async function main() {
  if (!process.env.POSTGRES_URL) throw new Error('Set POSTGRES_URL for the database to report on.')
  const days = Number(process.env.USAGE_REPORT_DAYS || 30)
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('USAGE_REPORT_DAYS must be 1–366.')
  const url = new URL(process.env.POSTGRES_URL)
  const client = new Client({ connectionString: url.href,
    ssl: ['localhost', '127.0.0.1'].includes(url.hostname) ? undefined : {rejectUnauthorized:false} })
  await client.connect()
  try {
    await client.query('begin read only')
    await client.query("set local statement_timeout = '15s'")
    const usage = await client.query(`select tier, count(distinct household_id)::int as active_households,
      sum(requests)::text as recorded_operations, sum(processing_ms)::text as wall_time_ms,
      sum(generated_occurrences)::text as scheduled_runs, sum(generated_tasks)::text as scheduled_tasks
      from household_usage_daily where usage_date >= current_date - ($1::int - 1)
      group by tier order by tier`, [days])
    const retained = await client.query(`with households_by_tier as (
      select h.id, case when o.user_id is not null then 'owner'
        when b.billing_hold is null and b.subscription_status in ('active','past_due','canceled')
          and b.paid_through > now() then 'premium' else 'free' end as tier
      from households h left join household_billing b on b.household_id=h.id
      left join owner_entitlements o on o.user_id=h.leader_id
    ) select h.tier, count(distinct h.id)::int as households, count(t.id)::text as retained_tasks
      from households_by_tier h left join tasks t on t.household_id=h.id group by h.tier order by h.tier`)
    const health = await client.query(`select
      (select count(*)::int from billing_webhook_events where processed_at is null) as pending_webhooks,
      (select count(*)::int from household_billing where stripe_customer_id is not null and
        (last_reconciled_at is null or last_reconciled_at < now()-interval '2 days')) as stale_billing_accounts,
      (select count(*)::int from household_waitlist) as waitlisted_accounts`)
    await client.query('commit')
    const warnings = []
    if (health.rows[0].pending_webhooks) warnings.push('Unprocessed webhook receipts: inspect failures and replay verified events.')
    if (health.rows[0].stale_billing_accounts) warnings.push('Billing reconciliation is stale: inspect cron delivery and Stripe credentials.')
    console.log(JSON.stringify({days, usage:usage.rows, retained:retained.rows, health:health.rows[0], warnings,
      measurementLimits:'Recorded flow reads/writes and cron work only; server-rendered dashboard and notification traffic require provider request metrics. Wall time is not billable CPU. Join with provider billing and request metrics before calculating cost per household.'},null,2))
  } finally { await client.end() }
}
main().catch(() => { console.error('Usage report failed. Check database access, migration 0016 and configuration.'); process.exitCode=1 })
