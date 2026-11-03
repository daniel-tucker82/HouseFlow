-- Schedule edits use immutable receipts too: an old retry acknowledges its
-- original result without reapplying obsolete rules over a later edit.
alter table planner_creations drop constraint if exists planner_creations_action_check;
alter table planner_creations add constraint planner_creations_action_check
  check (action in ('createRoutine', 'createTask', 'createOccurrence', 'saveRoutineSchedule'));
