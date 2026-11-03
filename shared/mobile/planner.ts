import type { Routine, RoutineOccurrence, Task } from "../../lib/types"
import type { HouseholdMember } from "./contracts"
import { validateTaskTiming, type TaskTiming } from "../scheduling"

export interface PlannerSnapshot {
  householdId: string
  routines: Routine[]
  tasks: Task[]
  dependencies: { source_task_id: string; target_task_id: string }[]
  taskAssignees: { task_id: string; user_id: string }[]
  members: HouseholdMember[]
  occurrences: RoutineOccurrence[]
}

export interface PlannerTaskDraft {
  taskId: string
  routineId: string
  isNew: boolean
  title: string
  notes: string
  isReward: boolean
  assigneeIds: string[]
  prerequisiteIds: string[]
  /** Omitted for basic edits, so retained timing is unchanged after a downgrade. */
  timing?: TaskTiming
}

export interface PlannerEdit {
  id: string
  accountId: string
  householdId: string
  deviceId: string
  revision: number
  draft: PlannerTaskDraft
  state: "pending" | "rejected"
  attempts: number
  nextAttemptMs: number
  error: string | null
}

export interface PlannerCreation {
  id: string
  accountId: string
  householdId: string
  label: string
  body: Record<string, unknown>
  state: "pending" | "rejected"
  attempts: number
  nextAttemptMs: number
  error: string | null
}

export function validatePlannerDraft(draft: PlannerTaskDraft) {
  if (!draft.title.trim()) throw new Error("Enter a task name.")
  if (draft.title.trim().length > 200 || draft.notes.length > 4000) throw new Error("Use a name up to 200 characters and notes up to 4,000 characters.")
  if (draft.prerequisiteIds.includes(draft.taskId)) throw new Error("A task cannot depend on itself.")
  if (draft.timing !== undefined) validateTaskTiming(draft.timing)
}

export function applyPlannerDraft(snapshot: PlannerSnapshot, draft: PlannerTaskDraft): PlannerSnapshot {
  // A removed task is never resurrected by a pending edit.
  if (!snapshot.tasks.some(task => task.id === draft.taskId)) return snapshot
  return { ...snapshot,
    tasks: snapshot.tasks.map(task => task.id === draft.taskId ? { ...task, title: draft.title.trim(),
      description: draft.notes.trim() || null, is_reward: draft.isReward, assignee_id: draft.assigneeIds[0] ?? null,
      ...(draft.timing === undefined ? {} : { unlock_rule: draft.timing.unlockRule, expiry_rule: draft.timing.expiryRule,
        unlock_combiner: draft.timing.unlockCombiner, unlock_at: null, expires_at: null, scheduled_time: null }) } : task),
    taskAssignees: [...snapshot.taskAssignees.filter(row => row.task_id !== draft.taskId), ...draft.assigneeIds.map(user_id => ({ task_id: draft.taskId, user_id }))],
    dependencies: [...snapshot.dependencies.filter(row => row.target_task_id !== draft.taskId),
      ...draft.prerequisiteIds.map(source_task_id => ({ source_task_id, target_task_id: draft.taskId }))],
  }
}

export function plannerDescendants(snapshot: PlannerSnapshot, taskId: string) {
  const found = new Set([taskId]), queue = [taskId]
  while (queue.length) {
    const source = queue.pop()
    for (const edge of snapshot.dependencies) if (edge.source_task_id === source && !found.has(edge.target_task_id)) {
      found.add(edge.target_task_id); queue.push(edge.target_task_id)
    }
  }
  return found
}

export function draftForTask(snapshot: PlannerSnapshot, task: Task): PlannerTaskDraft {
  const assignees = snapshot.taskAssignees.filter(row => row.task_id === task.id).map(row => row.user_id)
  return { taskId: task.id, routineId: task.routine_id!, isNew: false, title: task.title, notes: task.description ?? "",
    isReward: task.is_reward, assigneeIds: assignees.length ? assignees : task.assignee_id ? [task.assignee_id] : [],
    prerequisiteIds: snapshot.dependencies.filter(row => row.target_task_id === task.id).map(row => row.source_task_id) }
}
