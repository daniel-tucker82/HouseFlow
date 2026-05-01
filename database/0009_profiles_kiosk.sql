do $$
begin
  if exists (
    select 1
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    where t.typname = 'app_role' and e.enumlabel = 'leader'
  ) then
    alter type app_role rename value 'leader' to 'manager';
  end if;
exception
  when invalid_parameter_value then
    null;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    where t.typname = 'app_role' and e.enumlabel = 'supervisor'
  ) then
    alter type app_role add value 'supervisor';
  end if;
end $$;

create table if not exists household_kiosk_settings (
  household_id uuid primary key references households(id) on delete cascade,
  visible_member_ids text[] not null default '{}'::text[],
  editable_member_ids text[] not null default '{}'::text[],
  kiosk_active boolean not null default false,
  pin_hash text,
  session_token_hash text,
  updated_by text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists household_kiosk_settings_active_idx
  on household_kiosk_settings (kiosk_active);

