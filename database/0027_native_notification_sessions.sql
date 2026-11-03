alter table native_notification_devices add column if not exists session_id text;
alter table if exists native_notification_deliveries add column if not exists session_id text;
-- A revocation can arrive before an interrupted registration (or user creation).
-- Keep its tombstone so that a late registration cannot reactivate that session.
create table if not exists native_notification_revocations (
  device_id uuid not null references native_notification_installations(device_id) on delete cascade,
  account_id text not null,
  session_id text not null,
  created_at timestamptz not null default now(),
  primary key(device_id,account_id,session_id)
);
