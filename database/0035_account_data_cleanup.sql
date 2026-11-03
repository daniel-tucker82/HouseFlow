-- An account removal can empty another parent's kiosk selection. It must stay
-- locked, with no visible/editable members, rather than broadening access.
alter table native_kiosk_sessions drop constraint if exists native_kiosk_sessions_visible_member_ids_check;
alter table native_kiosk_sessions add constraint native_kiosk_sessions_visible_member_ids_check
  check (cardinality(visible_member_ids) between 0 and 500);

create or replace function cyntch_json_has_identifiers(document jsonb, identifiers text[])
returns boolean language plpgsql immutable set search_path from current as $$
declare child jsonb;
begin
  if jsonb_typeof(document)='string' then return (document#>>'{}')=any(identifiers); end if;
  if jsonb_typeof(document)='array' then
    for child in select value from jsonb_array_elements(document) loop
      if cyntch_json_has_identifiers(child,identifiers) then return true; end if;
    end loop;
  elsif jsonb_typeof(document)='object' then
    for child in select value from jsonb_each(document) loop
      if cyntch_json_has_identifiers(child,identifiers) then return true; end if;
    end loop;
  end if;
  return false;
end $$;

create or replace function cyntch_json_remove_identifiers(document jsonb, identifiers text[])
returns jsonb language plpgsql immutable set search_path from current as $$
begin
  if jsonb_typeof(document)='string' and (document#>>'{}')=any(identifiers) then return 'null'::jsonb; end if;
  if jsonb_typeof(document)='array' then
    return coalesce((select jsonb_agg(cyntch_json_remove_identifiers(value,identifiers) order by ordinal)
      from jsonb_array_elements(document) with ordinality as item(value,ordinal)
      where not (jsonb_typeof(value)='string' and (value#>>'{}')=any(identifiers))),'[]'::jsonb);
  elsif jsonb_typeof(document)='object' then
    return coalesce((select jsonb_object_agg(key,cyntch_json_remove_identifiers(value,identifiers)) from jsonb_each(document)),'{}'::jsonb);
  end if;
  return document;
end $$;

-- Old joined events identify their subject by actor. Old departure messages
-- did not save the departing member's ID. Preserve those events but remove
-- their untraceable display-name copies; new writers store the subject ID.
update notification_events set subject_member_user_id=actor_user_id
  where kind='member_joined_via_link' and subject_member_user_id is null and actor_user_id is not null;
update user_notifications n set body='Household membership changed.'
  from notification_events e where n.event_id=e.id and e.subject_member_user_id is null
    and e.kind in ('member_joined_via_link','member_left_household') and e.metadata ? 'memberName';
update notification_events set metadata=metadata-'memberName'
  where subject_member_user_id is null and kind in ('member_joined_via_link','member_left_household');
