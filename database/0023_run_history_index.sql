-- Stable keyset paging through household history without loading all task rows.
create index if not exists idx_occurrences_household_schedule_id
  on routine_occurrences(household_id,scheduled_for desc,id desc);
