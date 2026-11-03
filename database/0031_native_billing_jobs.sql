create table if not exists native_billing_webhook_receipts (
  project_id text not null,
  event_id text not null check (length(event_id) between 1 and 255),
  event_type text not null check (length(event_type) between 1 and 80),
  event_at timestamptz not null,
  environment text check (environment in ('production','sandbox')),
  app_id text,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  outcome text not null check (outcome in ('queued','unknown_customer','ignored_environment','ignored_app','ignored_type','test')),
  account_ids uuid[] not null default '{}',
  received_at timestamptz not null default now(),
  primary key (project_id,event_id)
);

-- Rows also schedule periodic verification after the immediate event is done.
-- A lease may expire after interruption; generations retain events that arrive
-- while the previous generation is being verified.
create table if not exists native_billing_jobs (
  account_id uuid primary key references native_billing_accounts(id) on delete restrict,
  requested_generation bigint not null default 1 check (requested_generation > 0),
  completed_generation bigint not null default 0 check (completed_generation >= 0 and completed_generation <= requested_generation),
  next_attempt_at timestamptz default now(),
  lease_id uuid,
  lease_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error_code text,
  last_completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((lease_id is null) = (lease_until is null))
);
create index if not exists native_billing_jobs_due on native_billing_jobs(next_attempt_at,account_id) where next_attempt_at is not null;
