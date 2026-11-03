-- Additive compatibility layer for native offline completions and web updates.
create table if not exists completion_operations (
  user_id text not null references users(id) on delete cascade,
  operation_id uuid not null,
  household_id uuid not null references households(id) on delete cascade,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id, operation_id)
);

create table if not exists completion_versions (
  occurrence_id uuid not null references routine_occurrences(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  operation_id uuid not null,
  device_id text not null,
  sequence bigint not null,
  corrected_time_ms bigint not null,
  primary key(occurrence_id, task_id)
);

create table if not exists completion_stream_versions (
  occurrence_id uuid not null references routine_occurrences(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  device_id text not null,
  sequence bigint not null,
  corrected_time_ms bigint not null,
  primary key(occurrence_id, task_id, device_id)
);
