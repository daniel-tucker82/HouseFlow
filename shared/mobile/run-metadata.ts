import type { BoardSnapshot, BoardTask } from "./contracts"
import type { RunEdit, RunEditorSnapshot } from "./run-editor"

type Metadata = Pick<BoardTask, "title" | "description" | "is_reward" | "assignee_ids">
const key = (occurrenceId: string, taskId: string) => `${occurrenceId}:${taskId}`

/** Metadata overlays never add tasks or alter completion, availability or timers. */
export function overlayRunMetadata<T extends BoardSnapshot>(snapshot: T, edits: RunEdit[]): T {
  const pending = new Map(edits.filter(edit => edit.householdId === snapshot.household.id && !edit.draft.isNew)
    .map(edit => [key(edit.draft.occurrenceId, edit.draft.taskId), edit]))
  return { ...snapshot, tasks: snapshot.tasks.map(task => {
    const edit = pending.get(key(task.occurrence_id, task.id))
    const blocker = task.blocking_task_id ? pending.get(key(task.occurrence_id, task.blocking_task_id)) : undefined
    return { ...task,
      ...(edit ? { title: edit.draft.title.trim(), description: edit.draft.notes.trim() || null,
        is_reward: edit.draft.isReward, assignee_ids: edit.draft.assigneeIds, metadata_sync: edit.state } : {}),
      ...(blocker ? { blocking_task_title: blocker.draft.title.trim(), blocking_task_assignee_ids: blocker.draft.assigneeIds } : {}),
    }
  }) }
}

/** Apply only the resolved task's metadata, preserving unrelated task fields and
 * newer completion revisions. A missing confirmed task stays absent. */
export function acceptRunMetadata<T extends BoardSnapshot>(snapshot: T, taskId: string, confirmed: RunEditorSnapshot): T {
  if (snapshot.household.id !== confirmed.householdId) return snapshot
  const task = confirmed.tasks.find(item => item.id === taskId)
  const assigned = confirmed.taskAssignees.filter(row => row.task_id === taskId).map(row => row.user_id)
  const metadata: Metadata | null = task ? { title: task.title, description: task.description ?? null,
    is_reward: task.is_reward, assignee_ids: assigned.length ? assigned : task.assignee_id ? [task.assignee_id] : [] } : null
  return { ...snapshot, tasks: snapshot.tasks.flatMap(item => {
    if (item.occurrence_id !== confirmed.occurrence.id) return [item]
    if (item.id === taskId) return metadata ? [{ ...item, ...metadata }] : []
    return [metadata && item.blocking_task_id === taskId ? { ...item, blocking_task_title: metadata.title, blocking_task_assignee_ids: metadata.assignee_ids } : item]
  }) }
}
