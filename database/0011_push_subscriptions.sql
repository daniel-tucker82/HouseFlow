create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references users(id) on delete cascade,
  device_id text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_seen_at timestamptz not null default now(),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_user_active
  on push_subscriptions(user_id, is_active);
