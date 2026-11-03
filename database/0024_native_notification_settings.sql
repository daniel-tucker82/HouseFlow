-- New native registrations are separate from archived Capacitor/FCM tokens.
-- An installation secret stays in secure storage across account switches. IDs alone cannot transfer ownership.
create table if not exists native_notification_installations (
  device_id uuid primary key,
  secret_hash text not null check (secret_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
create table if not exists native_notification_devices (
  user_id text not null references users(id) on delete cascade,
  device_id uuid not null references native_notification_installations(device_id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  platform text not null check (platform in ('android','ios')),
  permission text not null check (permission in ('undetermined','denied','granted','provisional')),
  expo_push_token text unique,
  device_name text,
  app_version text,
  updated_at timestamptz not null default now(),
  primary key(user_id,device_id),
  check (expo_push_token is null or permission in ('granted','provisional'))
);
create table if not exists native_notification_preferences (
  user_id text not null,
  device_id uuid not null,
  household_id uuid not null references households(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  preferences jsonb not null check (jsonb_typeof(preferences)='object'),
  updated_at timestamptz not null default now(),
  primary key(user_id,device_id,household_id),
  foreign key(user_id,device_id) references native_notification_devices(user_id,device_id) on delete cascade
);
create table if not exists native_notification_operations (
  user_id text not null references users(id) on delete cascade,
  device_id uuid not null,
  operation_id uuid not null,
  action text not null check (action in ('registerDevice','savePreferences')),
  household_id uuid references households(id) on delete cascade,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,device_id,operation_id)
);
