-- A manual run and its receipt commit together. Existing creation receipts stay
-- valid, including tombstones for removed items. Safe to apply more than once.
do $$ begin
  -- The migration runner also reapplies older files. Never narrow a constraint
  -- already extended by a later migration while newer receipt rows exist.
  if not exists (select 1 from pg_constraint where conrelid='planner_creations'::regclass
    and conname='planner_creations_action_check' and pg_get_constraintdef(oid) like '%''createOccurrence''%') then
    alter table planner_creations drop constraint if exists planner_creations_action_check;
    alter table planner_creations add constraint planner_creations_action_check
      check (action in ('createRoutine', 'createTask', 'createOccurrence'));
  end if;
end $$;
