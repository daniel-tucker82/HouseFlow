-- Native locks are independent of the legacy household-wide web kiosk.
-- Retain the household ID if the household is deleted: deletion must not unlock
-- the authenticated session and expose a different household's parent controls.
create table if not exists native_kiosk_sessions (
  id uuid primary key,
  sequence bigint generated always as identity unique,
  user_id text not null references users(id) on delete cascade,
  session_id text not null,
  device_id uuid not null references native_notification_installations(device_id),
  household_id uuid not null,
  visible_member_ids text[] not null,
  editable_member_ids text[] not null,
  exit_secret_hash text not null check (exit_secret_hash ~ '^[a-f0-9]{64}$'),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  state text not null default 'locked' check (state in ('locked','unlocked','recovered')),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  check (cardinality(visible_member_ids) between 1 and 500),
  check (editable_member_ids <@ visible_member_ids),
  check ((state='locked') = (ended_at is null))
);
create unique index if not exists native_kiosk_active_device on native_kiosk_sessions(device_id) where state='locked';
create unique index if not exists native_kiosk_active_session on native_kiosk_sessions(user_id,session_id) where state='locked';
create index if not exists native_kiosk_session_history on native_kiosk_sessions(user_id,session_id,sequence desc);
