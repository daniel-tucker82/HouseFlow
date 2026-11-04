-- One-off boards and their retry receipts commit together. Existing receipt
-- types and removed-entity tombstones remain valid. Safe to apply repeatedly.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='planner_creations'::regclass
    and conname='planner_creations_action_check' and pg_get_constraintdef(oid) like '%''createTaskBoard''%') then
    alter table planner_creations drop constraint if exists planner_creations_action_check;
    alter table planner_creations add constraint planner_creations_action_check
      check (action in ('createRoutine', 'createTask', 'createOccurrence', 'saveRoutineSchedule', 'createTaskBoard'));
  end if;
end $$;
