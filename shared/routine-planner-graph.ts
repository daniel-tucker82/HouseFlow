export type PlannerDependency = { source_task_id: string; target_task_id: string }

/** Stable prerequisite order; retain cyclic/missing-link tasks for inspection. */
export function orderPlannerTasks<T extends { id: string }>(tasks: T[], dependencies: PlannerDependency[]) {
  const remaining = [...tasks]
  const ids = new Set(tasks.map(task => task.id))
  const ordered: T[] = []
  const requirements = new Map(tasks.map(task => [task.id, new Set<string>()]))
  const dependents = new Map<string, Set<string>>()
  for (const edge of dependencies) {
    if (!ids.has(edge.source_task_id) || !ids.has(edge.target_task_id)) continue
    requirements.get(edge.target_task_id)!.add(edge.source_task_id)
    if (!dependents.has(edge.source_task_id)) dependents.set(edge.source_task_id, new Set())
    dependents.get(edge.source_task_id)!.add(edge.target_task_id)
  }
  while (remaining.length) {
    const next = remaining.findIndex(task => requirements.get(task.id)!.size === 0)
    if (next < 0) return [...ordered, ...remaining]
    const [task] = remaining.splice(next, 1)
    ordered.push(task)
    for (const target of dependents.get(task.id) ?? []) requirements.get(target)!.delete(task.id)
  }
  return ordered
}

/** Practice includes upstream tasks from other routines, never unrelated branches. */
export function prerequisiteClosure(taskIds: string[], dependencies: PlannerDependency[]) {
  const ids = new Set(taskIds), queue = [...ids]
  const sources = new Map<string, string[]>()
  for (const edge of dependencies) sources.set(edge.target_task_id, [...(sources.get(edge.target_task_id) ?? []), edge.source_task_id])
  while (queue.length) {
    for (const source of sources.get(queue.pop()!) ?? []) {
      if (!ids.has(source)) { ids.add(source); queue.push(source) }
    }
  }
  return ids
}
