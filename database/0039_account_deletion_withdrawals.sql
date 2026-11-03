-- An authenticated owner can withdraw an attempt only before acceptance.
-- Keep the opaque request fence permanently: a delayed old submission must
-- never become executable after the phone discards its recovery information.
create table if not exists account_deletion_withdrawals (
  id uuid primary key,
  account_hash text not null check (account_hash ~ '^[a-f0-9]{64}$'),
  recovery_key_hash text not null check (recovery_key_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);

-- Protect against an older in-flight application revision as well as current
-- code. Both outcomes claim the same operation lock and cannot coexist.
create or replace function cyntch_guard_deletion_decision()
returns trigger language plpgsql set search_path from current as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('account-deletion-operation:'||new.id::text,0)) then
    raise exception using errcode='P7602',message='Account access is changing. Please retry.';
  end if;
  if (tg_table_name='account_deletion_requests' and exists(select 1 from account_deletion_withdrawals where id=new.id))
    or (tg_table_name='account_deletion_withdrawals' and exists(select 1 from account_deletion_requests where id=new.id)) then
    raise exception using errcode='P7603',message='This deletion attempt already has a different outcome.';
  end if;
  return new;
end $$;
drop trigger if exists cyntch_deletion_decision on account_deletion_requests;
create trigger cyntch_deletion_decision before insert or update of id on account_deletion_requests
  for each row execute function cyntch_guard_deletion_decision();
drop trigger if exists cyntch_deletion_withdrawal_decision on account_deletion_withdrawals;
create trigger cyntch_deletion_withdrawal_decision before insert or update of id on account_deletion_withdrawals
  for each row execute function cyntch_guard_deletion_decision();
