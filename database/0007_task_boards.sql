-- Task boards are represented by routine_occurrences.
-- Routine-generated boards use kind='routine'; manual boards use kind='manual'.

alter table routine_occurrences
  add column if not exists household_id uuid references households(id) on delete cascade;

update routine_occurrences ro
set household_id = r.household_id
from routines r
where ro.routine_id = r.id
  and ro.household_id is null;

alter table routine_occurrences
  alter column routine_id drop not null;

alter table routine_occurrences
  add column if not exists kind text not null default 'routine'
  check (kind in ('routine', 'manual'));

alter table routine_occurrences
  add column if not exists title text;

update routine_occurrences
set kind = 'routine'
where kind is null;

create index if not exists idx_occurrences_household on routine_occurrences(household_id);
