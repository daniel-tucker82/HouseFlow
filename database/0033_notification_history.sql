-- Reading/dismissing history never deletes the canonical transition or changes push jobs.
create table if not exists native_notification_history_entries (
  user_id text not null references users(id) on delete cascade,
  device_id uuid not null,
  event_id uuid not null references native_notification_events(id) on delete cascade,
  is_read boolean not null default false,
  dismissed boolean not null default false,
  primary key(user_id,device_id,event_id)
);
create table if not exists native_notification_history_markers (
  user_id text not null references users(id) on delete cascade,
  device_id uuid not null,
  household_id uuid not null references households(id) on delete cascade,
  read_time timestamptz not null default '-infinity',
  read_id uuid not null default '00000000-0000-0000-0000-000000000000',
  hidden_time timestamptz not null default '-infinity',
  hidden_id uuid not null default '00000000-0000-0000-0000-000000000000',
  primary key(user_id,device_id,household_id)
);
create index if not exists native_notification_history_order
  on native_notification_events(household_id,occurred_at desc,id desc);
