import { db } from "@/lib/db"
import { normalizeRole } from "@/lib/household-authz"
import type { BoardTask, HouseholdMember, HouseholdSummary } from "@/shared/mobile/contracts"
import type { RunPage, RunSnapshot, RunSummary, RunView } from "@/shared/mobile/runs"
import { isCalendarDate } from "@/shared/scheduling"
import { OCCURRENCE_DISPLAY_TITLE_SQL } from "@/lib/occurrence-display"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const active = `(ro.status='active' and (not exists (select 1 from occurrence_tasks x where x.occurrence_id=ro.id)
  or exists (select 1 from occurrence_tasks x where x.occurrence_id=ro.id and x.status<>'completed')))`
const summary = `select ro.id,ro.routine_id,ro.kind,
  ${OCCURRENCE_DISPLAY_TITLE_SQL} as title,
  to_char(ro.scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as scheduled_for,
  case when ro.status='active' and counts.total_tasks>0 and counts.completed_tasks=counts.total_tasks then 'completed' else ro.status::text end as status,
  counts.total_tasks,counts.completed_tasks
  from routine_occurrences ro left join routines r on r.id=ro.routine_id and r.household_id=ro.household_id
  cross join lateral (select count(*)::int as total_tasks,count(*) filter(where ot.status='completed')::int as completed_tasks
    from occurrence_tasks ot where ot.occurrence_id=ro.id) counts`

export class RunReadError extends Error { constructor(message: string, public status = 400) { super(message) } }
function cursor(raw: string | null): { time: string; id: string } | null {
  if (!raw) return null
  try {
    if (raw.length > 300 || !/^[\w-]+$/.test(raw)) throw new Error()
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (!value || typeof value.time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.time) || !isCalendarDate(value.time.slice(0, 10)) || !Number.isFinite(Date.parse(value.time)) || typeof value.id !== "string" || !uuid.test(value.id)) throw new Error()
    return value
  } catch { throw new RunReadError("This history page is invalid. Refresh the list.") }
}

/** Membership and all rows are read from one snapshot, without mutating history. */
export async function readMobileRuns(userId: string, params: URLSearchParams): Promise<RunPage | RunSnapshot> {
  const householdId = params.get("householdId"), occurrenceId = params.get("occurrenceId"), view = params.get("view") ?? "active"
  if (!householdId || !uuid.test(householdId) || (occurrenceId && !uuid.test(occurrenceId)) || !["active", "past"].includes(view)) throw new RunReadError("Choose a valid household and run.")
  const after = cursor(params.get("cursor"))
  const client = await db.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const household = (await client.query<HouseholdSummary>(`select h.id,h.name,h.timezone,h.leader_id as "leaderId",hm.role
      from households h join household_members hm on hm.household_id=h.id where h.id=$1 and hm.user_id=$2`, [householdId, userId])).rows[0]
    if (!household) throw new RunReadError("Household access is no longer available.", 403)
    household.role = normalizeRole(household.role); household.timezone ||= "UTC"
    const fetchedAt = new Date().toISOString()
    if (!occurrenceId) {
      const rows = (await client.query<RunSummary>(`${summary} where ro.household_id=$1
        and ${view === "active" ? active : `not ${active}`}
        and ($2::timestamptz is null or (ro.scheduled_for,ro.id)<($2::timestamptz,$3::uuid))
        order by ro.scheduled_for desc,ro.id desc limit 26`, [householdId, after?.time ?? null, after?.id ?? null])).rows
      const items = rows.slice(0, 25), last = items.at(-1)
      await client.query("COMMIT")
      return { householdId, view: view as RunView, items, fetchedAt,
        nextCursor: rows.length > 25 && last ? Buffer.from(JSON.stringify({ time: last.scheduled_for, id: last.id })).toString("base64url") : null }
    }
    const run = (await client.query<RunSummary>(`${summary} where ro.household_id=$1 and ro.id=$2`, [householdId, occurrenceId])).rows[0]
    if (!run) throw new RunReadError("This run was removed from the household.", 404)
    const members = (await client.query<HouseholdMember>(`select hm.user_id as id,coalesce(u.full_name,u.email,hm.user_id) as name,u.avatar_url,hm.token_color,hm.role
      from household_members hm left join users u on u.id=hm.user_id where hm.household_id=$1 order by name`, [householdId])).rows.map(member => ({ ...member, role: normalizeRole(member.role) }))
    const tasks = (await client.query<BoardTask>(`select t.id,ot.occurrence_id,$3::text as occurrence_title,$4::text as occurrence_kind,
      t.title,t.description,t.is_reward,ot.status,ot.status_version::text,t.unlock_at,t.expires_at,
      coalesce((select array_agg(ta.user_id order by ta.user_id) from task_assignees ta where ta.task_id=t.id),'{}'::text[]) as assignee_ids,
      blocker.id as blocking_task_id,blocker.title as blocking_task_title,
      coalesce((select array_agg(ta.user_id order by ta.user_id) from task_assignees ta where ta.task_id=blocker.id),'{}'::text[]) as blocking_task_assignee_ids,
      case when ot.status<>'locked' then 'none' when blocker.title is not null then 'prerequisite' when t.unlock_at is not null then 'time' else 'none' end as lock_type
      from occurrence_tasks ot join tasks t on t.id=ot.task_id and t.household_id=$1
      left join lateral (select source.id,source.title from task_dependencies dep
        join occurrence_tasks prior on prior.task_id=dep.source_task_id and prior.occurrence_id=ot.occurrence_id
        join tasks source on source.id=prior.task_id and source.household_id=$1
        where dep.target_task_id=t.id and prior.status<>'completed' order by source.created_at,source.id limit 1) blocker on true
      where ot.occurrence_id=$2 order by t.created_at,t.id`, [householdId, occurrenceId, run.title, run.kind])).rows
    await client.query("COMMIT")
    return { household, members, tasks, fetchedAt, run }
  } catch (error) { await client.query("ROLLBACK"); throw error } finally { client.release() }
}
