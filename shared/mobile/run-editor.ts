import type { RoutineOccurrence, Task } from "../../lib/types"
import type { HouseholdMember } from "./contracts"
import { validatePlannerDraft, type PlannerSnapshot, type PlannerTaskDraft } from "./planner"

export interface RunTaskDraft extends Omit<PlannerTaskDraft, "routineId"> {
  occurrenceId: string
  routineId: string | null
  unlockAtOverride?: string | null
  expiryAtOverride?: string | null
}
export interface RunEditorSnapshot {
  householdId: string
  occurrence: RoutineOccurrence
  tasks: Task[]
  dependencies: PlannerSnapshot["dependencies"]
  taskAssignees: PlannerSnapshot["taskAssignees"]
  members: HouseholdMember[]
}
export interface RunEdit {
  id: string; accountId: string; householdId: string; deviceId: string; revision: number; deviceTimeMs: number;
  draft: RunTaskDraft; state: "pending" | "rejected"; attempts: number; nextAttemptMs: number; error: string | null
}
export function validateRunDraft(draft: RunTaskDraft) {
  validatePlannerDraft(draft)
  if (!draft.occurrenceId) throw new Error("Choose the task board to edit.")
  for (const instant of [draft.unlockAtOverride, draft.expiryAtOverride]) {
    if (instant && (!draft.timing || !Number.isFinite(Date.parse(instant)))) throw new Error("Choose valid task timing before setting an exact time.")
  }
}
export function validateRunSnapshot(snapshot: RunEditorSnapshot, householdId: string, occurrenceId: string) {
  if (snapshot.householdId !== householdId || snapshot.occurrence?.id !== occurrenceId || snapshot.occurrence.household_id !== householdId
    || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.dependencies) || !Array.isArray(snapshot.taskAssignees) || !Array.isArray(snapshot.members)
    || snapshot.tasks.some(task => task.household_id !== householdId || task.routine_occurrence_id !== occurrenceId || task.routine_id !== snapshot.occurrence.routine_id)) {
    throw new Error("The editor response did not match this task board.")
  }
  const ids = new Set(snapshot.tasks.map(task => task.id))
  if (ids.size !== snapshot.tasks.length || snapshot.dependencies.some(edge => !ids.has(edge.source_task_id) || !ids.has(edge.target_task_id))
    || snapshot.taskAssignees.some(row => !ids.has(row.task_id))) throw new Error("The task board contained unrelated task details.")
}
export function runTaskDraft(snapshot: RunEditorSnapshot, task: Task): RunTaskDraft {
  const assigned = snapshot.taskAssignees.filter(row => row.task_id === task.id).map(row => row.user_id)
  return { taskId: task.id, occurrenceId: snapshot.occurrence.id, routineId: snapshot.occurrence.routine_id, isNew: false,
    title: task.title, notes: task.description ?? "", isReward: task.is_reward,
    assigneeIds: assigned.length ? assigned : task.assignee_id ? [task.assignee_id] : [],
    prerequisiteIds: snapshot.dependencies.filter(edge => edge.target_task_id === task.id).map(edge => edge.source_task_id) }
}
export function runAsPlanner(snapshot: RunEditorSnapshot): PlannerSnapshot {
  return { ...snapshot, routines: [], occurrences: [snapshot.occurrence] }
}
export function applyRunDraft(snapshot: RunEditorSnapshot, draft: RunTaskDraft): RunEditorSnapshot {
  if (draft.occurrenceId !== snapshot.occurrence.id || draft.routineId !== snapshot.occurrence.routine_id) return snapshot
  let tasks = snapshot.tasks
  if (!tasks.some(task => task.id === draft.taskId)) {
    if (!draft.isNew) return snapshot
    tasks = [...tasks, { id: draft.taskId, household_id: snapshot.householdId, routine_id: draft.routineId,
      routine_occurrence_id: draft.occurrenceId, title: draft.title, status: "locked", assignee_id: null, is_reward: false, scheduled_time: null }]
  }
  return { ...snapshot, tasks: tasks.map(task => task.id === draft.taskId ? { ...task, title: draft.title.trim(), description: draft.notes.trim() || null,
    is_reward: draft.isReward, assignee_id: draft.assigneeIds[0] ?? null,
    ...(draft.timing ? { unlock_rule: draft.timing.unlockRule, expiry_rule: draft.timing.expiryRule, unlock_combiner: draft.timing.unlockCombiner,
      unlock_at: draft.unlockAtOverride ?? null, expires_at: draft.expiryAtOverride ?? null, scheduled_time: null } : {}) } : task),
    taskAssignees: [...snapshot.taskAssignees.filter(row => row.task_id !== draft.taskId), ...draft.assigneeIds.map(user_id => ({ task_id: draft.taskId, user_id }))],
    dependencies: [...snapshot.dependencies.filter(row => row.target_task_id !== draft.taskId), ...draft.prerequisiteIds.map(source_task_id => ({ source_task_id, target_task_id: draft.taskId }))] }
}
export function savedRunTask(value: unknown, edit: RunEdit): Task & { assignee_ids: string[]; prerequisite_ids: string[] } {
  const task = (value as { task?: Task & { prerequisite_ids: string[] } })?.task
  if (!task || task.id !== edit.draft.taskId || task.household_id !== edit.householdId || task.routine_occurrence_id !== edit.draft.occurrenceId
    || task.routine_id !== edit.draft.routineId || typeof task.title !== "string" || typeof task.is_reward !== "boolean"
    || !Array.isArray(task.assignee_ids) || task.assignee_ids.some(id => typeof id !== "string")
    || !Array.isArray(task.prerequisite_ids) || task.prerequisite_ids.some(id => typeof id !== "string" || id === task.id)) {
    throw new Error("The saved task did not match this board. Retrying safely.")
  }
  return task as Task & { assignee_ids: string[]; prerequisite_ids: string[] }
}
