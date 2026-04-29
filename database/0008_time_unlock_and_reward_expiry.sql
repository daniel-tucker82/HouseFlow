alter table households
  add column if not exists timezone text not null default 'UTC';

alter table tasks
  add column if not exists unlock_rule jsonb,
  add column if not exists unlock_at timestamptz,
  add column if not exists unlock_combiner text not null default 'and',
  add column if not exists expiry_rule jsonb,
  add column if not exists expires_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tasks_unlock_combiner_check'
  ) then
    alter table tasks
      add constraint tasks_unlock_combiner_check
      check (unlock_combiner in ('and', 'or'));
  end if;
end $$;

create index if not exists idx_tasks_unlock_at on tasks(unlock_at);
create index if not exists idx_tasks_expires_at on tasks(expires_at);
