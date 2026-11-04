import type { RunSummary } from "./runs"

export function boardCreationTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Enter a task board name.")
  const title = value.trim()
  if (title.length > 200) throw new Error("Use a task board name up to 200 characters.")
  return title
}

/** Validate the immutable creation receipt before removing its local request. */
export function createdBoard(value: unknown, householdId: string, title: unknown): RunSummary {
  const row = value as Record<string, unknown> | null
  if (!row || typeof row.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)
    || row.household_id !== householdId || row.routine_id !== null || row.kind !== "manual"
    || row.title !== boardCreationTitle(title) || row.status !== "active"
    || typeof row.scheduled_for !== "string" || !Number.isFinite(Date.parse(row.scheduled_for))) {
    throw new Error("The task board response did not match your saved request. Retrying safely.")
  }
  return { id: row.id, routine_id: null, kind: "manual", title: row.title as string,
    scheduled_for: row.scheduled_for, status: "active", total_tasks: 0, completed_tasks: 0 }
}
