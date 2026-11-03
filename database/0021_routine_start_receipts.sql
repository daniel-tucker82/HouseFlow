-- A manual run and its receipt commit together. Existing creation receipts stay
-- valid, including tombstones for removed items. Safe to apply more than once.
alter table planner_creations drop constraint if exists planner_creations_action_check;
alter table planner_creations add constraint planner_creations_action_check
  check (action in ('createRoutine', 'createTask', 'createOccurrence'));
