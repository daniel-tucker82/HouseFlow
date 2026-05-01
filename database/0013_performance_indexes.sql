-- Performance indexes for frequent task toggle/status refresh paths.
create index if not exists idx_occurrence_tasks_occurrence_status
  on occurrence_tasks(occurrence_id, status);

create index if not exists idx_occurrence_tasks_occurrence_task
  on occurrence_tasks(occurrence_id, task_id);

create index if not exists idx_task_dependencies_source_target
  on task_dependencies(source_task_id, target_task_id);

create index if not exists idx_task_dependencies_target_source
  on task_dependencies(target_task_id, source_task_id);
