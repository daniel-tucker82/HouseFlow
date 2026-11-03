-- A newly registered installation must not receive historical queued events.
alter table native_notification_devices add column if not exists created_at timestamptz not null default now();

create table if not exists native_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references native_notification_events(id) on delete cascade,
  user_id text not null,
  device_id uuid not null,
  state text not null default 'queued' check (state in
    ('queued','sending','awaiting_receipt','provider_accepted','suppressed','expired','failed')),
  attempts integer not null default 0,
  receipt_attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  token_hash text,
  ticket_id text,
  accepted_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  unique(event_id,user_id,device_id),
  foreign key(user_id,device_id) references native_notification_devices(user_id,device_id) on delete cascade
);
create index if not exists native_notification_deliveries_due
  on native_notification_deliveries(next_attempt_at,created_at,id) where state in ('queued','sending','awaiting_receipt');

