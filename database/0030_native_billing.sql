-- Store billing is independent of Stripe. Household deletion retires its
-- identity; it must not make an old purchase claimable by another household.
create table if not exists native_billing_accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete set null,
  project_id text not null check (length(project_id) between 1 and 255),
  environment text not null check (environment in ('production', 'sandbox')),
  requested_revision bigint not null default 0 check (requested_revision >= 0),
  applied_revision bigint not null default 0 check (applied_revision >= 0 and applied_revision <= requested_revision),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (household_id, environment)
);

create table if not exists native_subscriptions (
  project_id text not null,
  subscription_id text not null check (length(subscription_id) between 1 and 255),
  account_id uuid not null references native_billing_accounts(id) on delete restrict,
  store text not null check (store in ('app_store', 'play_store')),
  product_id text not null check (length(product_id) between 1 and 255),
  status text not null check (length(status) between 1 and 80),
  auto_renewal_status text not null check (length(auto_renewal_status) between 1 and 80),
  gives_access boolean not null,
  access_through timestamptz,
  verified_at timestamptz not null,
  primary key (project_id, subscription_id),
  check (not gives_access or access_through is not null)
);
create index if not exists native_subscriptions_access
  on native_subscriptions(account_id, access_through) where gives_access;
