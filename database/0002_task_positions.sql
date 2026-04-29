alter table tasks
  add column if not exists position_x double precision,
  add column if not exists position_y double precision;
