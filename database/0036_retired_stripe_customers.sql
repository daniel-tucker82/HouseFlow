-- A transferred household keeps its verified paid period, but never receives
-- the former owner's customer portal, cards or permission to renew their plan.
alter table household_billing add column if not exists stripe_customer_retired boolean not null default false;
alter table household_billing add column if not exists stripe_customer_deleted_at timestamptz;
alter table household_billing add column if not exists stripe_customer_generation integer not null default 0 check (stripe_customer_generation>=0);

