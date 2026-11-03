-- Server ordering is independent of the device clocks used to resolve edits.
-- All status writers (web, mobile, timers and recurrence) share this trigger.
create sequence if not exists occurrence_task_status_version_seq as bigint;

alter table occurrence_tasks add column if not exists status_version bigint not null
  default nextval('occurrence_task_status_version_seq');

create or replace function version_occurrence_task_status() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    new.status_version := nextval(format('%I.occurrence_task_status_version_seq', TG_TABLE_SCHEMA)::regclass);
  else
    new.status_version := old.status_version;
  end if;
  return new;
end;
$$;

create or replace trigger occurrence_task_status_version
before update on occurrence_tasks
for each row execute function version_occurrence_task_status();
