alter table users
  add column if not exists avatar_url text;

create table if not exists task_assignees (
  task_id uuid not null references tasks(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);

create index if not exists idx_task_assignees_user on task_assignees(user_id);
