import { orderPlannerTasks, prerequisiteClosure } from "../routine-planner-graph"
import type { PlannerSnapshot } from "./planner"

export interface PracticeTask {
  id: string; title: string; notes: string; isReward: boolean; members: string[];
  otherRoutine: string | null; prerequisites: { id: string; title: string }[]
}
export interface RoutinePractice {
  householdId: string; routineId: string; routineName: string; tasks: PracticeTask[]; completed: string[]
}
export type PracticeTaskState = PracticeTask & { status: "ready" | "waiting" | "completed"; waitingFor: string[] }

/** A detached, in-memory practice copy. No clock, network, storage or live
 * completion objects are involved. Time/expiry behavior belongs to real runs. */
export function createRoutinePractice(snapshot: PlannerSnapshot, routineId: string): RoutinePractice {
  const routine = snapshot.routines.find(item => item.id === routineId && item.household_id === snapshot.householdId)
  if (!routine) throw new Error("Open a routine in this household to try it out.")
  const templates = snapshot.tasks.filter(task => task.household_id === snapshot.householdId && !task.routine_occurrence_id)
  const ids = prerequisiteClosure(templates.filter(task => task.routine_id === routineId).map(task => task.id), snapshot.dependencies)
  const tasks = orderPlannerTasks(templates.filter(task => ids.has(task.id)), snapshot.dependencies)
  const titles = new Map(tasks.map(task => [task.id, task.title]))
  return { householdId: snapshot.householdId, routineId, routineName: routine.name, completed: [], tasks: tasks.map(task => {
    const assignees = snapshot.taskAssignees.filter(row => row.task_id === task.id).map(row => row.user_id)
    if (!assignees.length && task.assignee_id) assignees.push(task.assignee_id)
    return { id: task.id, title: task.title, notes: task.description ?? "", isReward: task.is_reward,
      members: snapshot.members.filter(member => assignees.includes(member.id)).map(member => member.name),
      otherRoutine: task.routine_id === routineId ? null : snapshot.routines.find(item => item.id === task.routine_id && item.household_id === snapshot.householdId)?.name ?? "another routine",
      prerequisites: [...new Set(snapshot.dependencies.filter(edge => edge.target_task_id === task.id).map(edge => edge.source_task_id))]
        .map(id => ({ id, title: titles.get(id) ?? "Unavailable task" })) }
  }) }
}

export function practiceTaskStates(practice: RoutinePractice): PracticeTaskState[] {
  const completed = new Set(practice.completed)
  return practice.tasks.map(task => {
    const waitingFor = task.prerequisites.filter(item => !completed.has(item.id)).map(item => item.title)
    return { ...task, waitingFor, status: completed.has(task.id) ? "completed" : waitingFor.length ? "waiting" : "ready" }
  })
}

/** Matches the website's one-way practice taps. Start again resets the copy. */
export function completePracticeTask(practice: RoutinePractice, taskId: string): RoutinePractice {
  if (practiceTaskStates(practice).find(task => task.id === taskId)?.status !== "ready") return practice
  return { ...practice, completed: [...practice.completed, taskId] }
}
export function resetRoutinePractice(practice: RoutinePractice): RoutinePractice { return { ...practice, completed: [] } }
