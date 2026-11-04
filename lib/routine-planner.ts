import { z } from "zod"
import { validateTaskTiming, type TaskTiming } from "@/shared/scheduling"

import type { PlannerDependency } from "@/shared/routine-planner-graph"
export { orderPlannerTasks, type PlannerDependency } from "@/shared/routine-planner-graph"

export const plannerTaskSchema = z.object({
  taskId: z.string().uuid(),
  routineId: z.string().uuid(),
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
}).refine(value => !value.prerequisiteIds.includes(value.taskId), {
  message: "A task cannot depend on itself.", path: ["prerequisiteIds"],
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
