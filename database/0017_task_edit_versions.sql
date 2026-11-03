-- Reject duplicate/late background saves, including requests surviving a reload.
-- Each browser stream keeps one version per edited task; task deletion cleans it up.
create table if not exists task_edit_versions (
  task_id uuid not null references tasks(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  stream_id uuid not null,
  revision bigint not null,
  save_id uuid not null,
  primary key (task_id, user_id, stream_id)
);
