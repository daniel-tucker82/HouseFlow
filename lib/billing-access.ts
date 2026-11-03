/** Sandbox access is permitted only in an explicitly non-production runtime. */
export function nativeBillingEnvironment(env: NodeJS.ProcessEnv = process.env): "production" | "sandbox" | null {
  if (env.NATIVE_BILLING_ENABLED !== "true") return null
  const environment = env.NATIVE_BILLING_ENVIRONMENT ?? "production"
  if (environment === "production") return environment
  if (environment === "sandbox" && env.VERCEL_ENV !== "production" &&
    (["preview", "development"].includes(env.VERCEL_ENV ?? "") || ["development", "test"].includes(env.NODE_ENV ?? ""))) return environment
  return null
}

// These arguments are SQL identifiers/expressions supplied only by our code,
// never request data. Centralising this predicate keeps scheduler and quotas in
// agreement, and prevents a Stripe hold from erasing a separate store purchase.
export function nativePremiumAccessSql(householdId: string, env: NodeJS.ProcessEnv = process.env) {
  const environment = nativeBillingEnvironment(env)
  if (!environment) return "false"
  return `exists (select 1 from native_billing_accounts nba
    join native_subscriptions ns on ns.account_id = nba.id
    where nba.household_id = ${householdId} and nba.environment = '${environment}'
      and ns.gives_access and ns.access_through > now())`
}

export function paidHouseholdAccessSql(householdId: string, stripeAlias: string, env: NodeJS.ProcessEnv = process.env) {
  return `(coalesce(${stripeAlias}.billing_hold is null
    and ${stripeAlias}.subscription_status in ('active', 'past_due', 'canceled')
    and ${stripeAlias}.paid_through > now(), false) or ${nativePremiumAccessSql(householdId, env)})`
}
