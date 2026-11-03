-- A durable request also acts as an account tombstone. Keep only its opaque
-- account hash and outcome after the provider/data cleanup has completed.
create table if not exists account_deletion_requests (
  id uuid primary key,
  account_hash text not null unique check (account_hash ~ '^[a-f0-9]{64}$'),
  account_id text,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending' check (state in ('pending','completed')),
  work jsonb not null check (jsonb_typeof(work)='object'),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  next_attempt_at timestamptz default now(),
  attempts integer not null default 0 check (attempts>=0),
  lease_id uuid,
  lease_until timestamptz,
  last_error_code text,
  check ((lease_id is null) = (lease_until is null)),
  check ((state='completed') = (completed_at is not null)),
  check (state<>'completed' or (account_id is null and work='{}'::jsonb and next_attempt_at is null))
);
create index if not exists account_deletion_requests_due on account_deletion_requests(next_attempt_at,id) where state='pending';

-- Stop a delayed profile upsert from resurrecting a deleting/deleted account,
-- including a request that began before the account was frozen. The same key
-- is used by HTTP request admission and deletion acceptance.
create or replace function cyntch_require_active_account(requested_account_id text)
returns void language plpgsql set search_path from current as $$
begin
  if not pg_try_advisory_xact_lock_shared(hashtextextended('account-deletion:'||requested_account_id,0)) then
    raise exception using errcode='P7602',message='Account access is changing. Please retry.';
  end if;
  if exists(select 1 from account_deletion_requests where account_hash=encode(sha256(convert_to(requested_account_id,'UTF8')),'hex')) then
    raise exception using errcode='P7601',message='Account deletion has been requested.';
  end if;
end $$;

create or replace function cyntch_guard_account_reference()
returns trigger language plpgsql set search_path from current as $$
begin
  perform cyntch_require_active_account(to_jsonb(new)->>tg_argv[0]);
  return new;
end $$;
drop trigger if exists cyntch_active_user on users;
create trigger cyntch_active_user before insert or update on users
  for each row execute function cyntch_guard_account_reference('id');
drop trigger if exists cyntch_active_member on household_members;
create trigger cyntch_active_member before insert or update of user_id,household_id on household_members
  for each row execute function cyntch_guard_account_reference('user_id');
drop trigger if exists cyntch_active_owner on households;
create trigger cyntch_active_owner before insert or update of leader_id on households
  for each row execute function cyntch_guard_account_reference('leader_id');
