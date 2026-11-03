-- A durable cross-provider reservation closes the gap between checking access
-- and opening a store/Checkout sheet. All writers use the household write lock.
create table if not exists billing_purchase_attempts (
  id uuid primary key,
  household_id uuid not null references households(id) on delete cascade,
  user_id text not null,
  session_id text not null,
  device_id uuid,
  provider text not null check (provider in ('stripe', 'app_store', 'play_store')),
  environment text not null check (environment in ('production', 'sandbox')),
  billing_interval text not null check (billing_interval in ('monthly', 'yearly')),
  state text not null default 'reserved' check (state in ('reserved', 'submitted', 'released', 'expired')),
  expires_at timestamptz not null,
  integration_suffix text not null check (integration_suffix ~ '^[a-z]{8}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (provider = 'stripe' or device_id is not null)
);
create unique index if not exists billing_purchase_one_open_per_household
  on billing_purchase_attempts(household_id,environment) where state in ('reserved', 'submitted');

-- Pending payments can exist without access. They still prevent a second
-- subscription from being started while the first payment is being resolved.
alter table native_subscriptions add column if not exists pending_payment boolean not null default false;
