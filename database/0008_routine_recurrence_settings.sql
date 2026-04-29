alter table routines
  add column if not exists complete_older_occurrences_on_new boolean not null default false;
