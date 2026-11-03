-- Capture committed changes, independently of web/account notification preferences.
-- No network delivery or per-device fan-out runs in a task-saving transaction.
alter table routine_occurrences add column if not exists created_via text not null default 'manual'
  check (created_via in ('manual','recurrence'));
alter table routine_occurrences add column if not exists completion_reason text
  check (completion_reason in ('tasks','newer_copy'));
alter table occurrence_tasks add column if not exists completion_reason text
  check (completion_reason in ('manual','expiry','newer_copy'));

create table if not exists native_notification_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  event_key text not null unique,
  kind text not null check (kind in ('task_available','task_completed','task_reopened','task_assigned',
    'task_completed_automatically','reward_available','reward_completed','routine_generated','routine_started',
    'routine_completed','routine_superseded','routine_reopened','member_joined','member_added','member_left')),
  member_ids text[] not null default '{}',
  subject jsonb not null check (jsonb_typeof(subject)='object'),
  occurred_at timestamptz not null default clock_timestamp(),
  state text not null default 'pending' check (state in ('pending','expanded','expired')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists native_notification_events_pending
  on native_notification_events(next_attempt_at,occurred_at,id) where state='pending';

-- The first before-image and final after-image produce one net change per subject.
-- This short-lived journal is removed by the deferred trigger before commit.
create table if not exists native_notification_changes (
  id uuid primary key default gen_random_uuid(),
  transaction_id xid8 not null default pg_current_xact_id(),
  household_id uuid not null references households(id) on delete cascade,
  subject_type text not null check (subject_type in ('task','routine','member')),
  primary_id uuid not null,
  secondary_id text not null default '',
  before_state jsonb,
  unique(transaction_id,subject_type,primary_id,secondary_id)
);

create or replace function native_notification_subject_state(subject_type text, primary_id uuid, secondary_id text)
returns jsonb language plpgsql set search_path from current as $$
declare result jsonb;
begin
  if subject_type='task' then
    select jsonb_build_object('householdId',ro.household_id,'occurrenceId',ro.id,'taskId',t.id,
      'routineId',ro.routine_id,'name',t.title,'isReward',t.is_reward,'status',ot.status,
      'completionReason',ot.completion_reason,'occurrenceStatus',ro.status,
      'memberIds',coalesce((select jsonb_agg(a.user_id order by a.user_id) from (
        select ta.user_id from task_assignees ta where ta.task_id=t.id
        union select t.assignee_id where t.assignee_id is not null
      ) a), '[]'::jsonb)) into result
    from occurrence_tasks ot join tasks t on t.id=ot.task_id
    join routine_occurrences ro on ro.id=ot.occurrence_id and ro.household_id=t.household_id
    where ot.occurrence_id=primary_id and ot.task_id=secondary_id::uuid;
  elsif subject_type='routine' then
    select jsonb_build_object('householdId',ro.household_id,'occurrenceId',ro.id,'routineId',ro.routine_id,
      'name',coalesce(r.name,ro.title,'Routine'),'createdVia',ro.created_via,'completionReason',ro.completion_reason,
      'status',case when ro.status='cancelled' then 'cancelled'
        when ro.status='completed' or (exists(select 1 from occurrence_tasks ot where ot.occurrence_id=ro.id)
          and not exists(select 1 from occurrence_tasks ot where ot.occurrence_id=ro.id and ot.status<>'completed'))
        then 'completed' else 'active' end) into result
    from routine_occurrences ro left join routines r on r.id=ro.routine_id and r.household_id=ro.household_id
    where ro.id=primary_id;
  else
    select jsonb_build_object('householdId',hm.household_id,'memberId',hm.user_id,
      'name',coalesce(u.full_name,'A household member'),
      'localProfile',u.email is null and hm.user_id not like 'user\_%' escape '\',
      'householdCreator',h.leader_id=hm.user_id) into result
    from household_members hm join users u on u.id=hm.user_id join households h on h.id=hm.household_id
    where hm.household_id=primary_id and hm.user_id=secondary_id;
  end if;
  return result;
end; $$;

create or replace function remember_native_notification_change(household uuid, subject_type text, primary_id uuid, secondary_id text default '')
returns void language plpgsql set search_path from current as $$
begin
  if household is null or not exists(select 1 from households where id=household) then return; end if;
  if exists(select 1 from native_notification_changes c where c.transaction_id=pg_current_xact_id()
    and c.subject_type=remember_native_notification_change.subject_type and c.primary_id=remember_native_notification_change.primary_id
    and c.secondary_id=remember_native_notification_change.secondary_id) then return; end if;
  insert into native_notification_changes(household_id,subject_type,primary_id,secondary_id,before_state)
    values(household,subject_type,primary_id,secondary_id,native_notification_subject_state(subject_type,primary_id,secondary_id))
    on conflict do nothing;
end; $$;

create or replace function capture_native_notification_change() returns trigger
language plpgsql set search_path from current as $$
declare occurrence uuid; task uuid; household uuid; member text; linked record;
begin
  if TG_TABLE_NAME='occurrence_tasks' then
    if TG_OP='UPDATE' and new.status is not distinct from old.status then return new; end if;
    occurrence := coalesce(new.occurrence_id,old.occurrence_id);
    task := coalesce(new.task_id,old.task_id);
    -- Application writers lock the parent before editing its tasks, keeping the
    -- ordering consistent with completion, recurrence and timer transactions.
    select household_id into household from routine_occurrences where id=occurrence for update;
    perform remember_native_notification_change(household,'routine',occurrence);
    perform remember_native_notification_change(household,'task',occurrence,task::text);
  elsif TG_TABLE_NAME='routine_occurrences' then
    if TG_OP='UPDATE' and new.status is not distinct from old.status then return new; end if;
    occurrence := coalesce(new.id,old.id); household := coalesce(new.household_id,old.household_id);
    perform remember_native_notification_change(household,'routine',occurrence);
  elsif TG_TABLE_NAME='household_members' then
    household := coalesce(new.household_id,old.household_id); member := coalesce(new.user_id,old.user_id);
    perform remember_native_notification_change(household,'member',household,member);
  else
    if TG_TABLE_NAME='tasks' then
      if new.assignee_id is not distinct from old.assignee_id then return new; end if;
      task := new.id;
    else task := coalesce(new.task_id,old.task_id); end if;
    for linked in select ro.id,ro.household_id from occurrence_tasks ot join routine_occurrences ro on ro.id=ot.occurrence_id
      where ot.task_id=task order by ro.id for update of ro
    loop
      perform remember_native_notification_change(linked.household_id,'task',linked.id,task::text);
    end loop;
  end if;
  if TG_OP='DELETE' then return old; else return new; end if;
end; $$;

create or replace function enqueue_native_notification(change_id uuid, household uuid, kind text, subject jsonb, members text[] default '{}')
returns void language sql set search_path from current as $$
  insert into native_notification_events(household_id,event_key,kind,subject,member_ids)
    values(household,change_id::text || ':' || kind,kind,subject,members)
    on conflict(event_key) do nothing;
$$;

create or replace function finish_native_notification_change() returns trigger
language plpgsql set search_path from current as $$
declare change native_notification_changes%rowtype; final jsonb; prior jsonb; kind text; members text[]; added text[]; subject jsonb;
begin
  select * into change from native_notification_changes where id=new.id;
  if not found then return null; end if; -- Household deleted in this transaction.
  prior := change.before_state;
  final := native_notification_subject_state(change.subject_type,change.primary_id,change.secondary_id);
  if change.subject_type='task' and final is not null and final->>'occurrenceStatus'<>'cancelled' then
    subject := final - array['status','completionReason','occurrenceStatus','memberIds'];
    select coalesce(array_agg(value order by value),'{}') into members from jsonb_array_elements_text(final->'memberIds');
    if (final->>'status') is distinct from (prior->>'status') then
      if final->>'status'='completed' then
        if final->>'completionReason'='newer_copy' then kind := null;
        elsif final->>'completionReason'='expiry' then kind := 'task_completed_automatically';
        elsif (final->>'isReward')::boolean then kind := 'reward_completed';
        else kind := 'task_completed'; end if;
      elsif prior->>'status'='completed' then kind := 'task_reopened';
      end if;
      if kind is not null then perform enqueue_native_notification(change.id,change.household_id,kind,subject,members); end if;
    end if;
    select coalesce(array_agg(value order by value),'{}') into added from jsonb_array_elements_text(final->'memberIds')
      where not coalesce(prior->'memberIds','[]'::jsonb) ? value;
    if cardinality(added)>0 and final->>'status'<>'completed' then
      perform enqueue_native_notification(change.id,change.household_id,'task_assigned',subject,added);
    end if;
    -- Reopening can make work startable again. An already startable task also
    -- becomes available to a newly assigned person, without alerting old assignees.
    if final->>'status'='unlocked' and ((prior->>'status') is distinct from 'unlocked' or cardinality(added)>0) then
      kind := case when (final->>'isReward')::boolean then 'reward_available' else 'task_available' end;
      perform enqueue_native_notification(change.id,change.household_id,kind,subject,
        case when prior->>'status'='unlocked' then added else members end);
    end if;
  elsif change.subject_type='routine' and final is not null and final->>'routineId' is not null then
    subject := final - array['status','completionReason','createdVia'];
    if prior is null and final->>'status'<>'cancelled' then
      kind := case when final->>'createdVia'='recurrence' then 'routine_generated' else 'routine_started' end;
      perform enqueue_native_notification(change.id,change.household_id,kind,subject);
    end if;
    kind := null;
    if final->>'status'='completed' and coalesce(prior->>'status','active')='active' then
      kind := case when final->>'completionReason'='newer_copy' then 'routine_superseded' else 'routine_completed' end;
    elsif final->>'status'='active' and prior->>'status'='completed' then kind := 'routine_reopened'; end if;
    if kind is not null then perform enqueue_native_notification(change.id,change.household_id,kind,subject); end if;
  elsif change.subject_type='member' then
    if prior is null and final is not null and not (final->>'householdCreator')::boolean then
      kind := case when (final->>'localProfile')::boolean then 'member_added' else 'member_joined' end;
      perform enqueue_native_notification(change.id,change.household_id,kind,final - array['localProfile','householdCreator']);
    elsif prior is not null and final is null then
      perform enqueue_native_notification(change.id,change.household_id,'member_left',prior - array['localProfile','householdCreator']);
    end if;
  end if;
  delete from native_notification_changes where id=change.id;
  return null;
end; $$;

create or replace trigger native_capture_occurrence_task before insert or update or delete on occurrence_tasks
  for each row execute function capture_native_notification_change();
create or replace trigger native_capture_routine before insert or update or delete on routine_occurrences
  for each row execute function capture_native_notification_change();
create or replace trigger native_capture_member before insert or delete on household_members
  for each row execute function capture_native_notification_change();
create or replace trigger native_capture_assignment before insert or delete on task_assignees
  for each row execute function capture_native_notification_change();
create or replace trigger native_capture_primary_assignment before update of assignee_id on tasks
  for each row execute function capture_native_notification_change();
drop trigger if exists native_finish_notification_change on native_notification_changes;
create constraint trigger native_finish_notification_change after insert on native_notification_changes
  deferrable initially deferred for each row execute function finish_native_notification_change();
