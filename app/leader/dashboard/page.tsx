import { createHousehold } from "@/lib/actions/household"
import { db } from "@/lib/db"
import { LeaderFlowEditor } from "@/components/leader/flow-editor"
import {
  getCurrentUserOrRedirect,
  getHouseholdRoutines,
  getHouseholdTasks,
  getUserHouseholds,
} from "@/lib/data"

type LeaderDashboardProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function LeaderDashboard({ searchParams }: LeaderDashboardProps) {
  const user = await getCurrentUserOrRedirect()
  const memberships = await getUserHouseholds(user.id)
  const leaderMemberships = memberships.filter((m) => m.role === "leader")

  if (leaderMemberships.length === 0) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 overflow-auto p-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">Create your first household</h1>
          <p className="text-sm text-muted-foreground">
            You are not a leader in any household yet. Create one to unlock the leader dashboard.
          </p>
        </header>

        <form
          action={createHousehold}
          className="flex max-w-md flex-col gap-3 rounded-xl border border-border/80 bg-card p-5 shadow-sm"
        >
          <h2 className="font-medium">Create household</h2>
          <input
            name="name"
            required
            className="rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring/40"
            placeholder="Household name"
          />
          <button
            type="submit"
            className="rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            Create household
          </button>
        </form>
      </main>
    )
  }

  const params = await searchParams
  const selectedHouseholdId =
    typeof params.household === "string" ? params.household : leaderMemberships[0].household.id
  const selectedRoutineId = typeof params.routine === "string" ? params.routine : ""
  const selectedOccurrenceId = typeof params.occurrence === "string" ? params.occurrence : ""
  const selectedHousehold =
    leaderMemberships.find((m) => m.household.id === selectedHouseholdId)?.household ??
    leaderMemberships[0].household

  const routines = await getHouseholdRoutines(selectedHousehold.id)
  const tasks = selectedOccurrenceId
    ? (
        await db.query(
          `select t.id,
                  t.household_id,
                  t.routine_id,
                  t.routine_occurrence_id,
                  t.assignee_id,
                  t.title,
                  t.description,
                  t.is_reward,
                  t.status,
                  t.position_x,
                  t.position_y,
                  t.scheduled_time,
                  t.unlock_rule,
                  t.unlock_at,
                  t.unlock_combiner,
                  t.expiry_rule,
                  t.expires_at
           from tasks t
           join occurrence_tasks ot on ot.task_id = t.id
           join routine_occurrences ro on ro.id = ot.occurrence_id
           join routines r on r.id = ro.routine_id
           where ot.occurrence_id = $1::uuid
             and r.household_id = $2
           order by t.created_at asc`,
          [selectedOccurrenceId, selectedHousehold.id],
        )
      ).rows
    : await getHouseholdTasks(selectedHousehold.id, selectedRoutineId || undefined)
  const allTasksResult = await db.query(
    `select id, routine_id, title, is_reward
     from tasks
     where household_id = $1
       and routine_occurrence_id is null
     order by created_at asc`,
    [selectedHousehold.id],
  )
  const depsResult = selectedOccurrenceId
    ? await db.query(
        `select td.source_task_id, td.target_task_id
         from task_dependencies td
         where exists (
                 select 1
                 from occurrence_tasks ot
                 where ot.occurrence_id = $1::uuid
                   and ot.task_id = td.source_task_id
               )
           and exists (
                 select 1
                 from occurrence_tasks ot2
                 where ot2.occurrence_id = $1::uuid
                   and ot2.task_id = td.target_task_id
               )`,
        [selectedOccurrenceId],
      )
    : await db.query(
        `select td.source_task_id, td.target_task_id
         from task_dependencies td
         join tasks src on src.id = td.source_task_id
         join tasks tgt on tgt.id = td.target_task_id
         where src.household_id = $1
           and src.routine_occurrence_id is null
           and tgt.routine_occurrence_id is null
           and ($2::uuid is null or (src.routine_id = $2::uuid and tgt.routine_id = $2::uuid))`,
        [selectedHousehold.id, selectedRoutineId || null],
      )
  const membersResult = await db.query(
    `select hm.user_id as id, coalesce(u.full_name, u.email, hm.user_id) as name, u.avatar_url, hm.token_color
     from household_members hm
     left join users u on u.id = hm.user_id
     where hm.household_id = $1
     order by name asc`,
    [selectedHousehold.id],
  )
  const taskAssigneesResult = selectedOccurrenceId
    ? await db.query(
        `select ta.task_id, ta.user_id
         from task_assignees ta
         join occurrence_tasks ot on ot.task_id = ta.task_id
         where ot.occurrence_id = $1::uuid`,
        [selectedOccurrenceId],
      )
    : await db.query(
        `select ta.task_id, ta.user_id
         from task_assignees ta
         join tasks t on t.id = ta.task_id
         where t.household_id = $1
          and t.routine_occurrence_id is null`,
        [selectedHousehold.id],
      )
  const templateTaskAssigneesResult = selectedOccurrenceId
    ? await db.query(
        `select ta.task_id, ta.user_id
         from task_assignees ta
         join tasks t on t.id = ta.task_id
         where t.household_id = $1
           and t.routine_occurrence_id is null`,
        [selectedHousehold.id],
      )
    : taskAssigneesResult
  const invitesResult = await db.query(
    `select id, code, expires_at, max_uses, uses_count, is_active, created_at
     from household_invites
     where household_id = $1
     order by created_at desc`,
    [selectedHousehold.id],
  )
  const occurrencesResult = await db.query(
    `select ro.id,
            ro.routine_id,
            ro.household_id,
            ro.kind,
            ro.title,
            ro.scheduled_for,
            ro.status,
            count(ot.task_id)::int as total_tasks,
            count(*) filter (where ot.status = 'completed')::int as completed_tasks
     from routine_occurrences ro
     left join occurrence_tasks ot on ot.occurrence_id = ro.id
     where ro.household_id = $1
     group by ro.id, ro.routine_id, ro.household_id, ro.kind, ro.title, ro.scheduled_for, ro.status
     order by ro.scheduled_for desc`,
    [selectedHousehold.id],
  )
  const occurrenceTaskStatusesResult = selectedOccurrenceId
    ? await db.query(
        `select task_id, status
         from occurrence_tasks
         where occurrence_id = $1`,
        [selectedOccurrenceId],
      )
    : { rows: [] }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-2">
      <LeaderFlowEditor
        households={leaderMemberships.map((membership) => membership.household)}
        selectedHouseholdId={selectedHousehold.id}
        selectedRoutineId={selectedRoutineId || null}
        routines={routines}
        tasks={tasks}
        allTasks={allTasksResult.rows}
        dependencies={depsResult.rows}
        members={membersResult.rows}
        invites={invitesResult.rows}
        occurrences={occurrencesResult.rows}
        selectedOccurrenceId={selectedOccurrenceId || null}
        occurrenceTaskStatuses={occurrenceTaskStatusesResult.rows}
        taskAssignees={taskAssigneesResult.rows}
        templateTaskAssignees={templateTaskAssigneesResult.rows}
      />
    </div>
  )
}
