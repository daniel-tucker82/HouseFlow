import type { PoolClient } from "pg"
import { hasTimeRule } from "@/lib/billing-policy"
import { assertRetainedTaskCapacity, assertTemplateCapacity, assertTemplateItemCapacity, EntitlementError, getHouseholdEntitlement } from "@/lib/entitlements"

export async function enforceFlowEntitlements(client: PoolClient, householdId: string, body: Record<string, unknown>) {
  const entitlement = await getHouseholdEntitlement(client, householdId)
  const { limits, tier } = entitlement
  const action = String(body.action)
  if (["createTask","updateTask"].includes(action) &&
      (String(body.title ?? "").length > 200 || String(body.notes ?? body.recurrenceRule ?? "").length > 4000)) {
    throw new EntitlementError("Use a title up to 200 characters and notes up to 4,000 characters.",400)
  }
  const free = tier === "free"
  if (["createTask","createOccurrence","createTaskBoard"].includes(action)) {
    let additional = 1
    if (action === "createOccurrence") {
      const template = await client.query("select count(*)::int as n from tasks where household_id=$1::uuid and routine_id=$2::uuid and routine_occurrence_id is null",[householdId,String(body.routineId ?? "")])
      additional = template.rows[0].n
    }
    await assertRetainedTaskCapacity(client,householdId,tier,additional)
  }
  if (action === "setOccurrenceTaskCompleted" && !body.completed) {
    const occurrenceId = String(body.occurrenceId ?? "")
    const occurrence = await client.query("select status from routine_occurrences where household_id=$1::uuid and id=$2::uuid", [householdId, occurrenceId])
    // Undoing a task in an already active run consumes no additional capacity,
    // including after a downgrade leaves the household above its current limit.
    if (occurrence.rows[0]?.status === "completed") {
      const active = await client.query(`select count(*)::int as n from routine_occurrences
        where household_id = $1::uuid and status = 'active' and id <> $2::uuid`, [householdId, occurrenceId])
      if (active.rows[0].n >= limits.activeExecutions) throw new EntitlementError("Finish an active run before reopening this one.",402)
    }
  }
  if (free && ["addRecurrenceRule", "updateRecurrenceRule", "createTaskBoard"].includes(action)) {
    throw new EntitlementError("Additional boards and automatic schedules require Premium.", 402)
  }
  if (free && action === "updateRoutineRecurrenceSettings" && body.completeOlderOccurrencesOnNew) {
    throw new EntitlementError("Automatic completion settings require Premium.", 402)
  }
  if (free && ["createTask", "updateTask"].includes(action)) {
    const timing = body.timing && typeof body.timing === "object" ? body.timing as Record<string, unknown> : null
    if (hasTimeRule(body.unlockRule) || hasTimeRule(body.expiryRule) || hasTimeRule(timing?.unlockRule) || hasTimeRule(timing?.expiryRule) ||
      body.unlockAtOverride || body.expiryAtOverride || body.scheduledTime || body.unlock_at || body.expires_at) {
      throw new EntitlementError("Time-based activation and expiry require Premium.", 402)
    }
  }
  if (action === "createRoutine") {
    if (free && body.recurrenceRule) throw new EntitlementError("Recurring schedules require Premium.", 402)
    await assertTemplateCapacity(client, householdId, limits.templates)
  }
  if (action === "createTask") {
    const occurrenceId = String(body.occurrenceId ?? "")
    const routineId = String(body.routineId ?? "")
    if (occurrenceId) {
      const occurrence = await client.query("select routine_id, status from routine_occurrences where id = $1::uuid and household_id = $2::uuid", [occurrenceId, householdId])
      if (!occurrence.rowCount) throw new EntitlementError("Run not found", 404)
      if (routineId && routineId !== occurrence.rows[0].routine_id) throw new EntitlementError("Template does not match this run", 400)
      if (free && !occurrence.rows[0].routine_id) throw new EntitlementError("Use your free template to create tasks.", 402)
      if (free) {
        if (occurrence.rows[0].status !== "active") throw new EntitlementError("Completed runs cannot receive new tasks.", 402)
        const active = await client.query("select count(*)::int as n from routine_occurrences where household_id=$1::uuid and status='active'",[householdId])
        if (active.rows[0].n > limits.activeExecutions) throw new EntitlementError("Finish existing runs before adding more tasks.",402)
        await assertTemplateItemCapacity(client, householdId, occurrence.rows[0].routine_id, Number.MAX_SAFE_INTEGER, true)
      }
      const count = await client.query("select count(*)::int as n from tasks where routine_occurrence_id = $1::uuid", [occurrenceId])
      if (count.rows[0].n >= limits.items) throw new EntitlementError("This run has reached its task and reward limit.", 402)
    } else {
      if (!routineId) throw new EntitlementError("Choose a template or board first.", 400)
      await assertTemplateItemCapacity(client, householdId, routineId, limits.items, free)
    }
  }
  if (["createTask", "updateTask"].includes(action)) {
    const assignees = Array.isArray(body.assigneeIds) ? body.assigneeIds.map(String) : []
    if (assignees.length) {
      const valid = await client.query("select user_id from household_members where household_id = $1::uuid and user_id = any($2::text[])", [householdId, assignees])
      if (valid.rowCount !== new Set(assignees).size) throw new EntitlementError("Invalid household assignee", 400)
    }
  }
  if (action === "updateTask") {
    const task = await client.query("select routine_id, routine_occurrence_id from tasks where id = $1::uuid and household_id = $2::uuid", [String(body.taskId ?? ""), householdId])
    if (!task.rowCount) throw new EntitlementError("Task not found", 404)
    if (body.occurrenceId && body.occurrenceId !== task.rows[0].routine_occurrence_id) throw new EntitlementError("Task does not belong to this run", 400)
    if (free && !task.rows[0].routine_occurrence_id) {
      await assertTemplateItemCapacity(client, householdId, task.rows[0].routine_id, Number.MAX_SAFE_INTEGER, true)
    }
  }
  if (["createDependency","deleteDependency","insertIntoDependency"].includes(action)) {
    const ids = [body.sourceTaskId,body.targetTaskId,...(action === "insertIntoDependency" ? [body.insertTaskId] : [])].map(String)
    const tasks = await client.query("select id,routine_id,routine_occurrence_id from tasks where household_id=$1::uuid and id=any($2::uuid[])",[householdId,ids])
    if (tasks.rowCount !== new Set(ids).size) throw new EntitlementError("Dependency task not found",404)
    const occurrenceId = body.occurrenceId || null
    if (tasks.rows.some(task=>task.routine_occurrence_id !== occurrenceId)) throw new EntitlementError("Dependencies must stay within one run or template.",400)
    if (!occurrenceId) {
      const routineIds = new Set(tasks.rows.map(task=>task.routine_id))
      if (routineIds.size !== 1 || !tasks.rows[0]?.routine_id) throw new EntitlementError("Dependencies must stay within one template.",400)
      if (free) await assertTemplateItemCapacity(client,householdId,tasks.rows[0].routine_id,Number.MAX_SAFE_INTEGER,true)
    }
  }
  if (["createOccurrence", "createTaskBoard"].includes(action)) {
    const count = await client.query("select count(*)::int as n from routine_occurrences where household_id = $1::uuid and status = 'active'", [householdId])
    if (count.rows[0].n >= limits.activeExecutions) throw new EntitlementError("Complete an active run before starting another.", 402)
    if (action === "createOccurrence") {
      const routineId = String(body.routineId ?? "")
      // Reuse item check for household ownership/selection, allowing a full template to run.
      await assertTemplateItemCapacity(client, householdId, routineId, limits.items + 1, free)
      if (free) {
        const timed = await client.query(`select 1 from tasks where routine_id = $1::uuid and routine_occurrence_id is null
          and (scheduled_time is not null or unlock_at is not null or expires_at is not null
            or (unlock_rule is not null and unlock_rule->>'kind' is distinct from 'none')
            or (expiry_rule is not null and expiry_rule->>'kind' is distinct from 'none')) limit 1`, [routineId])
        if (timed.rowCount) throw new EntitlementError("Remove timed settings from your free template before running it.", 402)
        if (body.scheduledFor && (!Number.isFinite(new Date(String(body.scheduledFor)).getTime()) ||
          Math.abs(new Date(String(body.scheduledFor)).getTime() - Date.now()) > 60000)) {
          throw new EntitlementError("Free routines can only be started now.", 402)
        }
      }
    }
  }
  return entitlement
}
