import { z } from "zod"
import { validateTaskTiming, type TaskTiming } from "@/shared/scheduling"

import type { PlannerDependency } from "@/shared/routine-planner-graph"
export { orderPlannerTasks, type PlannerDependency } from "@/shared/routine-planner-graph"

const taskFields = {
  taskId: z.string().uuid(),
  isNew: z.boolean(),
  title: z.string().trim().min(1, "Enter a task name.").max(250),
  notes: z.string().max(10000),
  isReward: z.boolean(),
  assigneeIds: z.array(z.string().min(1).max(250)).max(200),
  prerequisiteIds: z.array(z.string().uuid()).max(500),
  timing: z.unknown().transform((value, ctx): TaskTiming => {
    try { validateTaskTiming(value); return value }
    catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid task timing." }); return z.NEVER }
  }).optional(),
}
export const plannerTaskSchema = z.object({ ...taskFields, routineId: z.string().uuid() }).refine(value => !value.prerequisiteIds.includes(value.taskId), {
  message: "A task cannot depend on itself.", path: ["prerequisiteIds"],
})

export const runTaskSchema = z.object({ ...taskFields, occurrenceId: z.string().uuid(), routineId: z.string().uuid().nullish(),
  unlockAtOverride: z.string().datetime({ offset: true }).nullish(), expiryAtOverride: z.string().datetime({ offset: true }).nullish(),
}).refine(value => !value.prerequisiteIds.includes(value.taskId), {
  message: "A task cannot depend on itself.", path: ["prerequisiteIds"],
}).refine(value => !(value.unlockAtOverride || value.expiryAtOverride) || value.timing !== undefined, {
  message: "Include the task's timing rules when setting an exact availability or expiry time.", path: ["timing"],
})

export type PlannerTaskInput = z.infer<typeof plannerTaskSchema>

export function taskDescendants(dependencies: PlannerDependency[], taskId: string) {
  const found = new Set([taskId])
  const queue = [taskId]
  while (queue.length) {
    const source = queue.shift()!
    for (const edge of dependencies) {
      if (edge.source_task_id === source && !found.has(edge.target_task_id)) {
        found.add(edge.target_task_id)
        queue.push(edge.target_task_id)
      }
    }
  }
  return found
}
