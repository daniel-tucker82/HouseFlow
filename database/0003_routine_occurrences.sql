do $$
begin
  if not exists (select 1 from pg_type where typname = 'occurrence_status') then
    create type occurrence_status as enum ('active', 'completed', 'cancelled');
  end if;
end $$;

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

create index if not exists idx_occurrences_routine on routine_occurrences(routine_id);
create index if not exists idx_occurrence_tasks_occurrence on occurrence_tasks(occurrence_id);
