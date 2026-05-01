do $$
begin
  if not exists (select 1 from pg_type where typname = 'notification_kind') then
    create type notification_kind as enum (
      'task_unlocked_self',
      'task_unlocked_other',
      'reward_unlocked_self',
      'reward_unlocked_other',
      'routine_occurrence_generated',
      'member_joined_via_link',
      'member_left_household'
    );
  end if;
end $$;

create table if not exists notification_preferences (
  user_id text not null references users(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  task_unlocked_self_enabled boolean not null default true,
  task_unlocked_other_enabled boolean not null default false,
  reward_unlocked_self_enabled boolean not null default true,
  reward_unlocked_other_enabled boolean not null default false,
  routine_occurrence_generated_enabled boolean not null default true,
  member_joined_via_link_enabled boolean not null default true,
  member_left_household_enabled boolean not null default true,
  task_unlocked_other_member_ids jsonb not null default '[]'::jsonb,
  reward_unlocked_other_member_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, household_id)
);

create table if not exists notification_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  kind notification_kind not null,
  actor_user_id text references users(id) on delete set null,
  subject_task_id uuid references tasks(id) on delete cascade,
  subject_reward_id uuid references tasks(id) on delete cascade,
  subject_occurrence_id uuid references routine_occurrences(id) on delete cascade,
  subject_member_user_id text references users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists user_notifications (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references notification_events(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  title text not null,
  body text not null,
  is_read boolean not null default false,
  read_at timestamptz,
  suppressed boolean not null default false,
  suppressed_reason text,
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

create index if not exists idx_notification_events_household_created
  on notification_events(household_id, created_at desc);
create index if not exists idx_user_notifications_user_created
  on user_notifications(user_id, created_at desc);
create index if not exists idx_user_notifications_user_read
  on user_notifications(user_id, is_read, created_at desc);
