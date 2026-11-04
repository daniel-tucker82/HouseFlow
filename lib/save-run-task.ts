import type { PoolClient } from "pg"
import { db } from "@/lib/db"
import { runTaskSchema, taskDescendants, type PlannerDependency } from "@/lib/routine-planner"
import { PlannerSaveError } from "@/lib/save-planner-task"
import { claimTaskEditVersion } from "@/lib/task-edit-version"
import { recordPlannerCreation, type PlannerCreation } from "@/lib/planner-creation"
import { resolveExpiryAt, resolveUnlockAt } from "@/lib/time-rules"

/** A live task edit never changes its template or a different run. The caller
 * enforces household role, kiosk and entitlement checks before entering here.
 * Metadata, assignments, prerequisites, timing, final states and the receipt
 * share one transaction, including the deferred notification triggers.
 */
export async function saveRunTask(householdId: string, userId: string, raw: unknown, creation: PlannerCreation | null,
  refreshStatuses: (client: PoolClient, occurrenceId: string) => Promise<void>) {
  const parsed = runTaskSchema.safeParse(raw)
  if (!parsed.success) throw new PlannerSaveError(parsed.error.issues[0]?.message ?? "Invalid task.")
  const input = parsed.data, assignees = [...new Set(input.assigneeIds)], prerequisites = [...new Set(input.prerequisiteIds)]
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    // Match completion/timer lock ordering before locking a task or version.
    const occurrence = (await client.query<{ routine_id: string | null; status: string }>(
      "select routine_id,status from routine_occurrences where id=$1::uuid and household_id=$2::uuid for update", [input.occurrenceId, householdId])).rows[0]
    if (!occurrence) throw new PlannerSaveError("This task board was removed. Refresh your runs.", 404)
    if (occurrence.status === "cancelled") throw new PlannerSaveError("A cancelled run cannot be edited.", 409)
    if (input.routineId && input.routineId !== occurrence.routine_id) throw new PlannerSaveError("The routine does not match this run.")
    const existing = await client.query("select * from tasks where id=$1::uuid and household_id=$2::uuid and routine_occurrence_id=$3::uuid for update", [input.taskId, householdId, input.occurrenceId])
    if (!input.isNew && !existing.rowCount) throw new PlannerSaveError("This task was removed from the board. Refresh your runs.", 404)
    if (input.isNew && existing.rowCount) throw new PlannerSaveError("This task has already been saved. Refresh your runs.", 409)
    const resultForTask = async () => ({
      task: (await client.query(`select t.*,
        coalesce((select array_agg(a.user_id order by a.user_id) from task_assignees a where a.task_id=t.id),'{}'::text[]) as assignee_ids,
        coalesce((select array_agg(d.source_task_id order by d.source_task_id) from task_dependencies d where d.target_task_id=t.id),'{}'::uuid[]) as prerequisite_ids
        from tasks t where t.id=$1::uuid and t.household_id=$2::uuid and t.routine_occurrence_id=$3::uuid`, [input.taskId, householdId, input.occurrenceId])).rows[0],
      occurrenceTaskStatus: (await client.query("select task_id,status::text as status from occurrence_tasks where occurrence_id=$1::uuid and task_id=$2::uuid", [input.occurrenceId, input.taskId])).rows[0] ?? null,
    })
    if (!input.isNew && !await claimTaskEditVersion(client, userId, raw as Record<string, unknown>)) {
      const result = await resultForTask()
      await client.query("COMMIT")
      return result
    }
    const members = await client.query("select user_id from household_members where household_id=$1::uuid and user_id=any($2::text[])", [householdId, assignees])
    if (members.rowCount !== assignees.length) throw new PlannerSaveError("One of these people no longer belongs to this household.")
    const sources = await client.query("select id from tasks where household_id=$1::uuid and routine_occurrence_id=$2::uuid and id=any($3::uuid[])", [householdId, input.occurrenceId, prerequisites])
    if (sources.rowCount !== prerequisites.length) throw new PlannerSaveError("Choose prerequisite tasks from this board.")
    const edges = await client.query<PlannerDependency>(`select td.source_task_id,td.target_task_id from task_dependencies td
      join tasks source on source.id=td.source_task_id join tasks target on target.id=td.target_task_id
      where source.household_id=$1::uuid and target.household_id=$1::uuid
        and source.routine_occurrence_id=$2::uuid and target.routine_occurrence_id=$2::uuid`, [householdId, input.occurrenceId])
    const descendants = taskDescendants(edges.rows, input.taskId)
    if (prerequisites.some(id => descendants.has(id))) throw new PlannerSaveError("These prerequisites would create a circular task order.")
    if (input.isNew) {
      await client.query(`insert into tasks(id,household_id,routine_id,routine_occurrence_id,title,description,is_reward,assignee_id,status,created_by,position_x,position_y)
        values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,'locked',$9,80,
          (select coalesce(max(position_y),-100)+180 from tasks where routine_occurrence_id=$4::uuid))`,
      [input.taskId, householdId, occurrence.routine_id, input.occurrenceId, input.title, input.notes.trim() || null, input.isReward, assignees[0] ?? null, userId])
      await client.query("insert into occurrence_tasks(occurrence_id,task_id,status) values($1::uuid,$2::uuid,'locked')", [input.occurrenceId, input.taskId])
    } else {
      await client.query(`update tasks set title=$1,description=$2,is_reward=$3,assignee_id=$4,updated_at=now()
        where id=$5::uuid and household_id=$6::uuid and routine_occurrence_id=$7::uuid`,
      [input.title, input.notes.trim() || null, input.isReward, assignees[0] ?? null, input.taskId, householdId, input.occurrenceId])
    }
    if (input.timing !== undefined) {
      const { unlockRule, expiryRule, unlockCombiner } = input.timing
      const zone = (await client.query<{ timezone: string | null }>("select timezone from households where id=$1::uuid", [householdId])).rows[0]?.timezone ?? "UTC"
      // Live time-rule changes follow the web editor's edit-time baseline.
      // An ordinary title/assignment edit leaves existing instants untouched.
      const baseline = new Date(), unlockAt = input.unlockAtOverride ? new Date(input.unlockAtOverride) : resolveUnlockAt(unlockRule, baseline, zone)
      const expiresAt = input.expiryAtOverride ? new Date(input.expiryAtOverride) : resolveExpiryAt({ rule: expiryRule, generationAt: baseline, createdAt: baseline, unlockAt, timeZone: zone })
      await client.query(`update tasks set unlock_rule=$1::jsonb,expiry_rule=$2::jsonb,unlock_combiner=$3,
        unlock_at=$4::timestamptz,expires_at=$5::timestamptz,scheduled_time=null where id=$6::uuid`,
      [unlockRule && unlockRule.kind !== "none" ? JSON.stringify(unlockRule) : null, expiryRule && expiryRule.kind !== "none" ? JSON.stringify(expiryRule) : null,
        unlockCombiner, unlockAt?.toISOString() ?? null, expiresAt?.toISOString() ?? null, input.taskId])
    }
    await client.query("delete from task_assignees where task_id=$1::uuid", [input.taskId])
    await client.query("insert into task_assignees(task_id,user_id) select $1::uuid,unnest($2::text[])", [input.taskId, assignees])
    await client.query("delete from task_dependencies where target_task_id=$1::uuid", [input.taskId])
    await client.query("insert into task_dependencies(source_task_id,target_task_id) select unnest($1::uuid[]),$2::uuid", [prerequisites, input.taskId])
    await refreshStatuses(client, input.occurrenceId)
    const result = await resultForTask()
    await recordPlannerCreation(client, householdId, userId, creation, input.taskId, result)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally { client.release() }
}
