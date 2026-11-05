-- Retain the billing binding atomically before household cascades remove it.
-- No FK to the household or user: cleanup must survive both being deleted.
create table if not exists household_deletion_requests (
  id uuid primary key,
  household_id uuid not null unique,
  account_hash text not null check (account_hash ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('pending','completed')),
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_livemode boolean,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  next_attempt_at timestamptz,
  attempts integer not null default 0 check (attempts>=0),
  lease_id uuid,
  lease_until timestamptz,
  last_error_code text,
  check ((lease_id is null) = (lease_until is null)),
  check ((state='completed') = (completed_at is not null)),
  check (state<>'pending' or (stripe_livemode is not null and (stripe_customer_id is not null or stripe_subscription_id is not null))),
  check (state<>'completed' or (stripe_customer_id is null and stripe_subscription_id is null and stripe_livemode is null and next_attempt_at is null and lease_id is null))
);
create index if not exists household_deletion_requests_due on household_deletion_requests(next_attempt_at,id) where state='pending';
create index if not exists household_deletion_requests_account on household_deletion_requests(account_hash,created_at desc);
