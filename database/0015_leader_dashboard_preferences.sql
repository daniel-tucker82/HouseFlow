-- Account-wide household view preferences, retained across sessions and devices.
create table if not exists leader_dashboard_preferences (
  user_id text primary key references users (id) on delete cascade,
  hide_completed_tasks boolean not null default true,
  updated_at timestamptz not null default now()
);
