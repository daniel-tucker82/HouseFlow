/** Trusted SQL fragment. Callers use occurrence alias ro and join routine alias
 * r on both routine_id and household_id. Never expose recurrence storage keys
 * as the board name; an explicitly named one-off board keeps its own title. */
export const OCCURRENCE_DISPLAY_TITLE_SQL = `case
  when nullif(btrim(ro.title), '') is not null
    and (ro.kind = 'manual' or ro.title !~* '^Recurrence - [a-z0-9-]+$') then ro.title
  else coalesce(nullif(btrim(r.name), ''), case when ro.kind = 'manual' then 'Task board' else 'Routine' end)
end`
