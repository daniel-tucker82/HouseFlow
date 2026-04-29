-- Snapshot tasks: template rows keep routine_occurrence_id NULL;
-- each occurrence clones template tasks + deps + assignees and points occurrence_tasks at the clones.

alter table tasks
  add column if not exists routine_occurrence_id uuid references routine_occurrences(id) on delete cascade;

create index if not exists idx_tasks_routine_occurrence on tasks(routine_occurrence_id);
