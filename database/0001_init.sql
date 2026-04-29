create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type app_role as enum ('leader', 'member');
  end if;
  if not exists (select 1 from pg_type where typname = 'routine_type') then
    create type routine_type as enum ('recurring', 'one_off');
  end if;
  if not exists (select 1 from pg_type where typname = 'task_status') then
    create type task_status as enum ('locked', 'unlocked', 'completed');
  end if;
  if not exists (select 1 from pg_type where typname = 'occurrence_status') then
    create type occurrence_status as enum ('active', 'completed', 'cancelled');
  end if;
end $$;

create table if not exists users (
  id text primary key,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) >= 2),
  leader_id text not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists household_members (
  household_id uuid not null references households(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role app_role not null,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  code text not null unique,
  created_by text not null references users(id) on delete restrict,
  expires_at timestamptz not null,
  max_uses int not null default 10 check (max_uses > 0),
  uses_count int not null default 0 check (uses_count >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists routines (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  name text not null check (char_length(name) >= 2),
  type routine_type not null default 'recurring',
  recurrence_rule text,
  complete_older_occurrences_on_new boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  routine_id uuid references routines(id) on delete set null,
  assignee_id text references users(id) on delete set null,
  title text not null check (char_length(title) >= 1),
  description text,
  is_reward boolean not null default false,
  status task_status not null default 'locked',
  position_x double precision,
  position_y double precision,
  scheduled_time timestamptz,
  created_by text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists task_dependencies (
  source_task_id uuid not null references tasks(id) on delete cascade,
  target_task_id uuid not null references tasks(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (source_task_id, target_task_id),
  check (source_task_id <> target_task_id)
);

create table if not exists task_assignees (
  task_id uuid not null references tasks(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

create table if not exists routine_occurrences (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references routines(id) on delete cascade,
  scheduled_for timestamptz not null,
  status occurrence_status not null default 'active',
  created_by text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists occurrence_tasks (
  occurrence_id uuid not null references routine_occurrences(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  status task_status not null default 'locked',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (occurrence_id, task_id)
);

create index if not exists idx_members_user on household_members(user_id);
create index if not exists idx_routines_household on routines(household_id);
create index if not exists idx_tasks_household on tasks(household_id);
create index if not exists idx_tasks_routine on tasks(routine_id);
create index if not exists idx_deps_target on task_dependencies(target_task_id);
create index if not exists idx_task_assignees_user on task_assignees(user_id);
create index if not exists idx_occurrences_routine on routine_occurrences(routine_id);
create index if not exists idx_occurrence_tasks_occurrence on occurrence_tasks(occurrence_id);
