-- A foreground board can subscribe separately from user-visible push settings.
-- This is a wake-up hint only. Read the board through its normal permission
-- checks after subscribing/reconnecting; disconnected listeners do not replay.
create or replace function notify_board_household(schema_name text, family uuid) returns void
language sql strict as $$
  select pg_notify('cyntch_board_' || md5(schema_name || ':' || family::text), '');
$$;

create or replace function signal_board_status_changes() returns trigger
language plpgsql set search_path from current as $$
declare family uuid;
begin
  for family in
    select distinct ro.household_id
    from board_status_after a
    join board_status_before b using (occurrence_id, task_id)
    join routine_occurrences ro on ro.id=a.occurrence_id
    where a.status is distinct from b.status
  loop
    -- PostgreSQL delivers after commit and coalesces identical hints within a
    -- transaction. Keep household names, identities and task data off the wire.
    perform notify_board_household(TG_TABLE_SCHEMA, family);
  end loop;
  return null;
end; $$;

create or replace trigger board_occurrence_status_changed
after update on occurrence_tasks
referencing old table as board_status_before new table as board_status_after
for each statement execute function signal_board_status_changes();

-- Other board changes have no semantic relationship to notification banners:
-- editing an active task's title must refresh an open tablet without alerting
-- a family member. Exclude timestamp-only updates, especially profile refreshes.
create index if not exists idx_board_occurrences_by_task on occurrence_tasks(task_id,occurrence_id);

create or replace function signal_board_row_change() returns trigger
language plpgsql set search_path from current as $$
declare family uuid; linked_task uuid;
begin
  if TG_TABLE_NAME='households' then
    perform notify_board_household(TG_TABLE_SCHEMA, coalesce(new.id,old.id));
  elsif TG_TABLE_NAME='users' then
    for family in select household_id from household_members where user_id=new.id loop
      perform notify_board_household(TG_TABLE_SCHEMA, family);
    end loop;
  elsif TG_TABLE_NAME in ('routine_occurrences','household_members','routines') then
    if TG_OP<>'INSERT' then perform notify_board_household(TG_TABLE_SCHEMA, old.household_id); end if;
    if TG_OP<>'DELETE' then perform notify_board_household(TG_TABLE_SCHEMA, new.household_id); end if;
  elsif TG_TABLE_NAME='occurrence_tasks' then
    select household_id into family from routine_occurrences where id=coalesce(new.occurrence_id,old.occurrence_id);
    perform notify_board_household(TG_TABLE_SCHEMA, family);
  else
    if TG_TABLE_NAME='tasks' then linked_task := new.id;
    elsif TG_TABLE_NAME='task_dependencies' then linked_task := coalesce(new.target_task_id,old.target_task_id);
    else linked_task := coalesce(new.task_id,old.task_id); end if;
    for family in select distinct ro.household_id from occurrence_tasks ot
      join routine_occurrences ro on ro.id=ot.occurrence_id where ot.task_id=linked_task and ro.status='active' loop
      perform notify_board_household(TG_TABLE_SCHEMA, family);
    end loop;
  end if;
  return null;
end; $$;

create or replace trigger board_task_details after update on tasks for each row
when ((old.title,old.description,old.is_reward,old.unlock_at,old.expires_at,old.unlock_combiner,old.assignee_id)
  is distinct from (new.title,new.description,new.is_reward,new.unlock_at,new.expires_at,new.unlock_combiner,new.assignee_id))
execute function signal_board_row_change();
create or replace trigger board_task_rows after insert or delete on occurrence_tasks for each row execute function signal_board_row_change();
create or replace trigger board_task_assignments after insert or delete on task_assignees for each row execute function signal_board_row_change();
create or replace trigger board_task_dependencies after insert or delete on task_dependencies for each row execute function signal_board_row_change();
create or replace trigger board_run_rows after insert or delete on routine_occurrences for each row execute function signal_board_row_change();
create or replace trigger board_run_details after update on routine_occurrences for each row
when ((old.status,old.title,old.kind,old.routine_id,old.household_id) is distinct from (new.status,new.title,new.kind,new.routine_id,new.household_id))
execute function signal_board_row_change();
create or replace trigger board_routine_name after update of name on routines for each row
when (old.name is distinct from new.name) execute function signal_board_row_change();
create or replace trigger board_member_rows after insert or delete on household_members for each row execute function signal_board_row_change();
create or replace trigger board_member_details after update on household_members for each row
when ((old.role,old.token_color) is distinct from (new.role,new.token_color)) execute function signal_board_row_change();
create or replace trigger board_household_details after update on households for each row
when ((old.name,old.timezone,old.leader_id) is distinct from (new.name,new.timezone,new.leader_id)) execute function signal_board_row_change();
create or replace trigger board_household_removed after delete on households for each row execute function signal_board_row_change();
create or replace trigger board_profile_details after update on users for each row
when ((old.full_name,old.email,old.avatar_url) is distinct from (new.full_name,new.email,new.avatar_url)) execute function signal_board_row_change();
