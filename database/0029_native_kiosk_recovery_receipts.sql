-- A parent can recover a locally locked device even when activation never
-- reached the server. Keep that decision so a delayed activation cannot relock it.
create table if not exists native_kiosk_recoveries (
  kiosk_id uuid primary key,
  user_id text not null references users(id) on delete cascade,
  device_id uuid not null references native_notification_installations(device_id),
  session_id text not null,
  recovered_by_session_id text not null,
  recovered_at timestamptz not null default now(),
  check (session_id <> recovered_by_session_id)
);
create index if not exists native_kiosk_recovered_session on native_kiosk_recoveries(user_id,session_id);

-- A verified local PIN can cancel an activation before it reaches the server.
-- This ends only that operation; normal parent access keeps its current session.
create table if not exists native_kiosk_cancellations (
  kiosk_id uuid primary key,
  user_id text not null references users(id) on delete cascade,
  device_id uuid not null references native_notification_installations(device_id),
  session_id text not null,
  exit_secret_hash text not null check (exit_secret_hash ~ '^[a-f0-9]{64}$'),
  cancelled_at timestamptz not null default now()
);
