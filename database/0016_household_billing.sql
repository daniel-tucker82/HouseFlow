-- Additive only. No existing routines, tasks or history are deleted.
create table if not exists owner_entitlements (
  user_id text primary key references users(id) on delete restrict,
  verified_email text not null,
  granted_at timestamptz not null default now(),
  verification_source text not null check (verification_source = 'clerk_verified_email')
);

create table if not exists household_billing (
  household_id uuid primary key references households(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  subscription_status text not null default 'none',
  paid_through timestamptz,
  cancel_at_period_end boolean not null default false,
  free_routine_id uuid references routines(id) on delete set null,
  last_reconciled_at timestamptz,
  last_scheduled_check_at timestamptz,
  last_activity_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table household_billing add column if not exists last_scheduled_check_at timestamptz;
alter table household_billing add column if not exists billing_hold text;

create table if not exists billing_risk_events (
  event_id text primary key,
  household_id uuid references households(id) on delete set null,
  event_type text not null,
  stripe_object_id text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists billing_webhook_events (
  event_id text primary key,
  event_type text not null,
  stripe_created_at timestamptz not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts integer not null default 0,
  last_error text
);

create table if not exists household_usage_daily (
  household_id uuid not null references households(id) on delete cascade,
  usage_date date not null default current_date,
  tier text not null check (tier in ('free', 'premium', 'owner')),
  requests bigint not null default 0,
  generated_tasks bigint not null default 0,
  generated_occurrences bigint not null default 0,
  processing_ms bigint not null default 0,
  primary key (household_id, usage_date, tier)
);

create table if not exists application_rate_limits (
  bucket_key text not null,
  window_start timestamptz not null,
  requests integer not null default 1,
  primary key (bucket_key, window_start)
);
create index if not exists idx_application_rate_limits_expiry on application_rate_limits(window_start);

create table if not exists household_waitlist (
  user_id text primary key references users(id) on delete cascade,
  requested_at timestamptz not null default now()
);
