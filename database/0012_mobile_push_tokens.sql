create table if not exists mobile_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('ios', 'android')),
  device_id text,
  device_name text,
  app_version text,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_mobile_push_tokens_user_active
  on mobile_push_tokens(user_id, is_active);
