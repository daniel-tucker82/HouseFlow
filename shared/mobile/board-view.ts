import type { BoardSnapshot, BoardTask } from "./contracts"
import type { NativeKioskSession } from "./kiosk"

export type BoardFilter = "active" | "all" | "unlocked" | "completed"
/** null follows the household membership; an explicit empty list means nobody. */
export interface BoardDisplayPreferences { version: 1; visibleMemberIds: string[] | null; editableMemberIds: string[] | null }
export const defaultBoardDisplay = (): BoardDisplayPreferences => ({ version: 1, visibleMemberIds: null, editableMemberIds: null })
export const boardTaskKey = (task: Pick<BoardTask, "id" | "occurrence_id">) => `${task.occurrence_id}:${task.id}`

export function parseBoardDisplay(value: unknown): BoardDisplayPreferences {
  if (value === null) return defaultBoardDisplay()
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { version?: unknown }).version !== 1) throw new Error("The saved display settings could not be read.")
  const input = value as Record<string, unknown>
  const ids = (items: unknown) => {
    if (items === null) return null
    if (!Array.isArray(items) || items.length > 500 || items.some(id => typeof id !== "string" || !id.length || id.length > 200)) throw new Error("Choose valid household members.")
    return [...new Set(items as string[])]
  }
  return { version: 1, visibleMemberIds: ids(input.visibleMemberIds), editableMemberIds: ids(input.editableMemberIds) }
}

export function boardDisplayAccess(board: BoardSnapshot, preferences: BoardDisplayPreferences, accountId: string, kiosk?: NativeKioskSession) {
  const all = board.members.map(member => member.id)
  if (kiosk && (kiosk.accountId !== accountId || kiosk.householdId !== board.household.id)) return { visibleMemberIds: [], editableMemberIds: [] }
  const visible = kiosk?.visibleMemberIds ?? (board.household.role === "member" ? null : preferences.visibleMemberIds) ?? all
  const visibleMemberIds = [...new Set(visible)].filter(id => all.includes(id))
  const editable = kiosk?.editableMemberIds ?? (board.household.role === "member" ? [accountId] : preferences.editableMemberIds) ?? visibleMemberIds
  return { visibleMemberIds, editableMemberIds: [...new Set(editable)].filter(id => visibleMemberIds.includes(id)) }
}

export function taskMembers(task: BoardTask, leaderId: string) { return task.assignee_ids.length ? task.assignee_ids : [leaderId] }

/** A display preference can restrict an action, never grant a role or kiosk permission. */
export function boardCompletionActor(board: BoardSnapshot, task: BoardTask, accountId: string, access: ReturnType<typeof boardDisplayAccess>, selectedMember: string | null, kiosk?: NativeKioskSession): string | null {
  const current = board.tasks.find(item => boardTaskKey(item) === boardTaskKey(task))
  if (!current || current.status === "locked") return null
  if (kiosk && (kiosk.accountId !== accountId || kiosk.householdId !== board.household.id)) return null
  const candidates = kiosk ? current.assignee_ids : taskMembers(current, board.household.leaderId)
  return candidates.find(id => access.visibleMemberIds.includes(id) && access.editableMemberIds.includes(id)
    && (!selectedMember || selectedMember === id)
    && (kiosk ? kiosk.visibleMemberIds.includes(id) && kiosk.editableMemberIds.includes(id) : board.household.role !== "member" || id === accountId)) ?? null
}

/** Match the web board's ready/completed/waiting order, with nearer prerequisites first. */
export function orderBoardTasks(tasks: BoardTask[]): BoardTask[] {
  const byId = new Map(tasks.map(task => [boardTaskKey(task), task])), depths = new Map<string, number>()
  const depth = (task: BoardTask) => {
    const path: string[] = [], seen = new Set<string>()
    let current: BoardTask | undefined = task, value = 0
    while (current?.status === "locked" && current.blocking_task_id) {
      const key = boardTaskKey(current)
      if (depths.has(key)) { value = depths.get(key)!; break }
      if (seen.has(key)) break
      seen.add(key); path.push(key)
      current = byId.get(`${current.occurrence_id}:${current.blocking_task_id}`)
    }
    for (const key of path.reverse()) depths.set(key, ++value)
    return depths.get(boardTaskKey(task)) ?? 0
  }
  const rank = { unlocked: 0, completed: 1, locked: 2 }
  const rows = tasks.map((task, index) => ({ task, index, depth: depth(task), created: Date.parse(task.created_at ?? "") }))
  const haveCreationTimes = rows.every(row => Number.isFinite(row.created))
  return rows.sort((a, b) => rank[a.task.status] - rank[b.task.status] || a.depth - b.depth
    || (haveCreationTimes ? a.created - b.created : 0) || a.index - b.index).map(row => row.task)
}

export function filterBoardTasks(tasks: BoardTask[], filter: BoardFilter, search: string) {
  const query = search.trim().toLocaleLowerCase()
  return tasks.filter(task => (filter === "all" || (filter === "active" ? task.status !== "completed" : task.status === filter))
    && (!query || `${task.title} ${task.occurrence_title ?? ""}`.toLocaleLowerCase().includes(query)))
}
