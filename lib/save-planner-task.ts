import { db } from "@/lib/db"
import { plannerTaskSchema, taskDescendants, type PlannerDependency } from "@/lib/routine-planner"
import { claimTaskEditVersion } from "@/lib/task-edit-version"
import { recordPlannerCreation, type PlannerCreation } from "@/lib/planner-creation"

export class PlannerSaveError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

/** Save basic task details, assignments and prerequisites as one operation.
 * Time rules, expiry rules and existing canvas positions are deliberately preserved.
 */
export async function savePlannerTask(householdId: string, userId: string, raw: unknown, creation: PlannerCreation | null = null) {
  const parsed = plannerTaskSchema.safeParse(raw)
  if (!parsed.success) throw new PlannerSaveError(parsed.error.issues[0]?.message ?? "Invalid task.")
  const input = parsed.data
  const assignees = [...new Set(input.assigneeIds)]
  const prerequisites = [...new Set(input.prerequisiteIds)]
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`routine-planner:${householdId}`])
    const routine = await client.query("select id from routines where id = $1::uuid and household_id = $2::uuid for update", [input.routineId, householdId])
    if (!routine.rowCount) throw new PlannerSaveError("Routine not found.", 404)
    const existing = await client.query("select id from tasks where id = $1::uuid and household_id = $2::uuid and routine_id = $3::uuid and routine_occurrence_id is null for update", [input.taskId, householdId, input.routineId])
    if (!input.isNew && !existing.rowCount) throw new PlannerSaveError("This task was removed. Refresh the routine.", 404)
    if (input.isNew && existing.rowCount) throw new PlannerSaveError("This task has already been saved. Refresh the routine.", 409)
    if (!input.isNew && !await claimTaskEditVersion(client, userId, raw as Record<string, unknown>)) {
      const current = await client.query("select * from tasks where id = $1::uuid and household_id = $2::uuid", [input.taskId, householdId])
      await client.query("COMMIT")
      return current.rows[0]
    }
    const members = await client.query("select user_id from household_members where household_id = $1::uuid and user_id = any($2::text[])", [householdId, assignees])
    if (members.rowCount !== assignees.length) throw new PlannerSaveError("One of these people no longer belongs to this household.")
    const sources = await client.query("select id, routine_id from tasks where household_id = $1::uuid and routine_occurrence_id is null and id = any($2::uuid[])", [householdId, prerequisites])
    if (sources.rowCount !== prerequisites.length) throw new PlannerSaveError("A prerequisite is no longer available in this household.")
    const edges = await client.query<PlannerDependency>(`select td.source_task_id, td.target_task_id
      from task_dependencies td join tasks t on t.id = td.source_task_id
      where t.household_id = $1::uuid and t.routine_occurrence_id is null`, [householdId])
    const descendants = taskDescendants(edges.rows, input.taskId)
    const previousSources = new Set(edges.rows.filter(edge => edge.target_task_id === input.taskId).map(edge => edge.source_task_id))
    if (sources.rows.some(source => source.routine_id !== input.routineId && !previousSources.has(source.id))) {
      throw new PlannerSaveError("Choose prerequisite tasks from this routine.")
    }
    if (prerequisites.some(id => descendants.has(id))) throw new PlannerSaveError("These prerequisites would create a circular task order.")
    let result
    if (input.isNew) {
      result = await client.query(`insert into tasks
        (id, household_id, routine_id, title, description, is_reward, assignee_id, status, created_by, position_x, position_y)
        values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'locked', $8, 80,
          (select coalesce(max(position_y), -100) + 180 from tasks where routine_id = $3::uuid and routine_occurrence_id is null))
        returning *`, [input.taskId, householdId, input.routineId, input.title, input.notes.trim() || null, input.isReward, assignees[0] ?? null, userId])
    } else {
      result = await client.query(`update tasks set title = $1, description = $2, is_reward = $3, assignee_id = $4, updated_at = now()
        where id = $5::uuid and household_id = $6::uuid and routine_id = $7::uuid and routine_occurrence_id is null returning *`,
      [input.title, input.notes.trim() || null, input.isReward, assignees[0] ?? null, input.taskId, householdId, input.routineId])
    }
    await client.query("delete from task_assignees where task_id = $1::uuid", [input.taskId])
    await client.query("insert into task_assignees (task_id, user_id) select $1::uuid, unnest($2::text[])", [input.taskId, assignees])
    await client.query("delete from task_dependencies where target_task_id = $1::uuid", [input.taskId])
    await client.query("insert into task_dependencies (source_task_id, target_task_id) select unnest($1::uuid[]), $2::uuid", [prerequisites, input.taskId])
    await recordPlannerCreation(client, householdId, userId, creation, input.taskId, { task: result.rows[0] })
    await client.query("COMMIT")
    return result.rows[0]
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
