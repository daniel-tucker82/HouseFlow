import { db } from "@/lib/db"
import { anchorRecurrenceRule, parseRoutineRecurrenceRules, serializeRoutineRecurrenceRules } from "@/lib/recurrence"
import { PlannerCreationError, recordPlannerCreation, type PlannerCreation } from "@/lib/planner-creation"
import { onlyReducesAutomation, sameRoutineSchedule, scheduleForRoutine, validateRoutineSchedule, type RoutineSchedule } from "@/shared/routine-schedule"
import type { Routine } from "@/lib/types"

/** Caller holds the household write lock and has checked access and kiosk state. */
export async function saveRoutineSchedule(householdId: string, userId: string, body: Record<string, unknown>, creation: PlannerCreation | null, automationAllowed: boolean) {
  if (!creation || creation.action !== "saveRoutineSchedule" || typeof body.routineId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.routineId)) throw new PlannerCreationError("A saved schedule request and routine are required.")
  const checked = (value: unknown): RoutineSchedule => {
    try { validateRoutineSchedule(value); return value }
    catch (error) { throw new PlannerCreationError(error instanceof Error ? error.message : "Invalid schedule.") }
  }
  const baseSchedule = checked(body.baseSchedule), schedule = checked(body.schedule)
  // Validate outside the transaction, then compare the editable rules under a
  // row lock. Scheduler watermarks are deliberately absent from the comparison.
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const row = (await client.query<Routine>("select * from routines where id=$1::uuid and household_id=$2::uuid for update", [body.routineId, householdId])).rows[0]
    if (!row) throw new PlannerCreationError("This routine was removed. Refresh your routines.", 404)
    const current = scheduleForRoutine(row)
    if (!sameRoutineSchedule(current, baseSchedule)) throw new PlannerCreationError("This schedule changed on another device. Review your saved schedule against the household’s current settings.", 409)
    if (!automationAllowed && !onlyReducesAutomation(current, schedule)) throw new PlannerCreationError("Automatic schedules require Premium. You can still remove saved recurrences or turn off automatic completion.", 402)
    const timezone = (await client.query<{ timezone: string }>("select timezone from households where id=$1::uuid", [householdId])).rows[0]?.timezone ?? "UTC"
    const existing = new Map(parseRoutineRecurrenceRules(row.recurrence_rule).map(rule => [rule.id, rule]))
    const now = new Date()
    const rules = schedule.rules.map(rule => anchorRecurrenceRule({ ...rule, lastGeneratedAt: existing.get(rule.id)?.lastGeneratedAt }, now, timezone))
    const saved = (await client.query<Routine>(`update routines set recurrence_rule=$1,complete_older_occurrences_on_new=$2,updated_at=now()
      where id=$3::uuid and household_id=$4::uuid returning *`, [rules.length ? serializeRoutineRecurrenceRules(rules) : null, schedule.completeOlderOccurrencesOnNew, body.routineId, householdId])).rows[0]
    const result = { routine: saved }
    await recordPlannerCreation(client, householdId, userId, creation, saved.id, result)
    await client.query("COMMIT")
    return result
  } catch (error) { await client.query("ROLLBACK"); throw error } finally { client.release() }
}
