-- Schedule edits use immutable receipts too: an old retry acknowledges its
-- original result without reapplying obsolete rules over a later edit.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='planner_creations'::regclass
    and conname='planner_creations_action_check' and pg_get_constraintdef(oid) like '%''saveRoutineSchedule''%') then
    alter table planner_creations drop constraint if exists planner_creations_action_check;
    alter table planner_creations add constraint planner_creations_action_check
      check (action in ('createRoutine', 'createTask', 'createOccurrence', 'saveRoutineSchedule'));
  end if;
end $$;
