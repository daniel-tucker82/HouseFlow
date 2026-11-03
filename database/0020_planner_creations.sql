-- Keep creation receipts after an entity is removed, so a delayed retry cannot
-- recreate it. Household/account deletion still removes the associated data.
create table if not exists planner_creations (
  household_id uuid not null references households(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  operation_id uuid not null,
  action text not null check (action in ('createRoutine', 'createTask')),
  entity_id uuid not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (household_id, user_id, operation_id)
);
