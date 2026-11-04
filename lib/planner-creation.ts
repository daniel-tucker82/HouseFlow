import { createHash } from "node:crypto"
import type { PoolClient } from "pg"

export class PlannerCreationError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
export interface PlannerCreation { id: string; action: "createRoutine" | "createTask" | "createOccurrence" | "saveRoutineSchedule" | "createTaskBoard"; hash: string; occurrenceId?: string }

export function taskBoardCreationInput(body: Record<string, unknown>) {
  if (body.title !== undefined && typeof body.title !== "string") throw new PlannerCreationError("Enter a task board name.")
  const title = String(body.title ?? "").trim() || "New task board"
  if (title.length > 200) throw new PlannerCreationError("Use a task board name up to 200 characters.")
  if (body.scheduledFor !== undefined && (typeof body.scheduledFor !== "string" || !Number.isFinite(Date.parse(body.scheduledFor)))) {
    throw new PlannerCreationError("Choose a valid task board start time.")
  }
  return { title, scheduledFor: body.scheduledFor as string | undefined }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}
export function parsePlannerCreation(body: Record<string, unknown>): PlannerCreation | null {
  if (body.action === "createTaskBoard") taskBoardCreationInput(body)
  if (body.action === "createOccurrence" && (typeof body.routineId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.routineId) ||
    (body.scheduledFor !== undefined && (typeof body.scheduledFor !== "string" || !Number.isFinite(Date.parse(body.scheduledFor)))))) {
    throw new PlannerCreationError("Choose a valid routine and start time.")
  }
  if (body.creationId === undefined) return null
  if (typeof body.creationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.creationId) ||
    !["createRoutine", "createTask", "createOccurrence", "saveRoutineSchedule", "createTaskBoard"].includes(String(body.action)) ||
    (body.action === "createTask" && !Object.hasOwn(body, "prerequisiteIds"))) {
    throw new PlannerCreationError("Invalid routine creation request.")
  }
  return { id: body.creationId, action: body.action as PlannerCreation["action"], hash: createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex"),
    ...(body.action === "createTask" && typeof body.occurrenceId === "string" ? { occurrenceId: body.occurrenceId } : {}) }
}

/** Caller holds the household write lock and has checked current membership.
 * Replays bypass only capacity admission; route-level kiosk checks still run.
 */
export async function findPlannerCreation(client: PoolClient, householdId: string, userId: string, creation: PlannerCreation) {
  const row = (await client.query<{ action: string; entity_id: string; request_hash: string; result: Record<string, unknown> }>(
    "select action,entity_id,request_hash,result from planner_creations where household_id=$1::uuid and user_id=$2 and operation_id=$3::uuid",
    [householdId, userId, creation.id])).rows[0]
  if (!row) return null
  if (row.action !== creation.action || row.request_hash !== creation.hash) throw new PlannerCreationError("This saved request was already used for different details.", 409)
  if (row.result.dataRemoved === true) throw new PlannerCreationError("This saved response included data that has been removed. Refresh the household.", 410)
  const exists = await client.query(creation.action === "createRoutine" || creation.action === "saveRoutineSchedule"
    ? "select id from routines where id=$1::uuid and household_id=$2::uuid"
    : creation.action === "createOccurrence" || creation.action === "createTaskBoard"
      ? "select id from routine_occurrences where id=$1::uuid and household_id=$2::uuid"
      : "select id from tasks where id=$1::uuid and household_id=$2::uuid and routine_occurrence_id is not distinct from $3::uuid",
    creation.action === "createTask" ? [row.entity_id, householdId, creation.occurrenceId ?? null] : [row.entity_id, householdId])
  if (!exists.rowCount) throw new PlannerCreationError("This item was saved, then removed. It has not been recreated.", 410)
  return row.result
}

/** Must share the entity's transaction. Never write the receipt after COMMIT. */
export async function recordPlannerCreation(client: PoolClient, householdId: string, userId: string, creation: PlannerCreation | null,
  entityId: string, result: Record<string, unknown>) {
  if (!creation) return
  await client.query(`insert into planner_creations(household_id,user_id,operation_id,action,entity_id,request_hash,result)
    values($1::uuid,$2,$3::uuid,$4,$5::uuid,$6,$7::jsonb)`, [householdId, userId, creation.id, creation.action, entityId, creation.hash, JSON.stringify(result)])
}
