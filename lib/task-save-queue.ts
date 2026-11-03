import type { Task } from "./types"

export type TaskEdit = {
  action: "updateTask"
  householdId: string
  taskId: string
  title: string
  notes: string
  isReward: boolean
  assigneeIds: string[]
  [key: string]: unknown
}

export type TaskSave = {
  id: string
  edit: TaskEdit
  patch: Partial<Task>
  state: "pending" | "retrying" | "error"
  error?: string
  attempts: number
  due: number
  created: number
}

type Storage = Pick<globalThis.Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">
type Options = {
  storage: Storage
  send: (edit: TaskEdit) => Promise<Task>
  lock: (work: () => Promise<void>) => Promise<void>
  now?: () => number
}

export class TaskSaveFailure extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export function taskEditPatch(edit: TaskEdit): Partial<Task> {
  return {
    title: edit.title, description: edit.notes.trim() || null, is_reward: edit.isReward,
    assignee_id: edit.assigneeIds[0] ?? null, assignee_ids: edit.assigneeIds,
    ...(Object.hasOwn(edit, "unlockRule") ? {
      unlock_rule: edit.unlockRule as Task["unlock_rule"],
      unlock_combiner: edit.unlockCombiner as Task["unlock_combiner"],
      expiry_rule: edit.expiryRule as Task["expiry_rule"],
      ...(edit.unlockAtOverride ? { unlock_at: String(edit.unlockAtOverride) } : {}),
      ...(edit.expiryAtOverride ? { expires_at: String(edit.expiryAtOverride) } : {}),
    } : {}),
  }
}

/** One durable record per task; newer unsent edits replace older unsent edits.
 * The worker belongs to the signed-in session, never to an editor component.
 */
export class TaskSaveQueue {
  private options: Options
  private prefix: string
  private clockKey: string
  private listeners = new Set<() => void>()
  private changes = new Set<(save: TaskSave) => void>()
  private jobs: TaskSave[] = []
  private confirmed = new Map<string, { save: TaskSave; revision: number }>()
  private running = false
  private active = false
  private timer: ReturnType<typeof setTimeout> | undefined
  revision = 0

  constructor(userId: string, options: Options) {
    this.options = options
    this.prefix = `cyntch:task-edits:v1:${userId}:`
    this.clockKey = `cyntch:task-edit-clock:v1:${userId}`
  }

  private now() { return this.options.now?.() ?? Date.now() }
  private taskKey(edit: TaskEdit) { return `${this.prefix}${edit.householdId}:${edit.taskId}` }
  private key(save: TaskSave) { return `${this.taskKey(save.edit)}:${save.id}` }
  private readRecords(): TaskSave[] {
    const result: TaskSave[] = []
    const storage = this.options.storage
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (!key?.startsWith(this.prefix)) continue
      const save = JSON.parse(storage.getItem(key) ?? "null") as TaskSave | null
      if (save?.edit?.action === "updateTask" && save.id) result.push(save)
    }
    return result
  }
  private read(): TaskSave[] {
    const latest = new Map<string, TaskSave>()
    for (const save of this.readRecords().sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))) latest.set(this.taskKey(save.edit), save)
    return [...latest.values()]
  }
  private publish(save?: TaskSave) {
    this.jobs = this.read()
    this.revision++
    if (save) {
      const latest = this.jobs.find(job => this.taskKey(job.edit) === this.taskKey(save.edit)) ?? save
      this.changes.forEach(listener => listener(latest))
    }
    this.listeners.forEach(listener => listener())
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  onChange = (listener: (save: TaskSave) => void) => {
    this.changes.add(listener)
    // Restore the visible edit on remount, including when the network is offline.
    const current = new Map([...this.confirmed].map(([key, value]) => [key, value.save]))
    for (const save of this.jobs) current.set(this.taskKey(save.edit), save)
    current.forEach(listener)
    return () => { this.changes.delete(listener) }
  }
  getSnapshot = () => this.jobs

  start() { this.active = true; this.sync() }
  stop() { this.active = false; clearTimeout(this.timer) }
  sync() { this.publish(); this.jobs.forEach(save => this.changes.forEach(listener => listener(save))); this.schedule() }

  enqueue(edit: TaskEdit, delay = 250) {
    const stored = JSON.parse(this.options.storage.getItem(this.clockKey) ?? "null") as { id: string; revision: number } | null
    const clock = { id: stored?.id ?? crypto.randomUUID(), revision: Math.max(this.now(), (stored?.revision ?? 0) + 1) }
    this.options.storage.setItem(this.clockKey, JSON.stringify(clock))
    const older = this.readRecords().filter(save => this.taskKey(save.edit) === this.taskKey(edit))
    const created = clock.revision
    const id = crypto.randomUUID()
    const save: TaskSave = { id, edit: { ...edit, saveStreamId: clock.id, saveRevision: created, saveId: id }, patch: taskEditPatch(edit), state: "pending", attempts: 0, due: this.now() + delay, created }
    // Persist synchronously before the editor can close or report acceptance.
    this.options.storage.setItem(this.key(save), JSON.stringify(save))
    // Each revision has its own key: an acknowledgement in another tab can
    // never delete a newer edit written between its read and its removal.
    for (const previous of older) this.options.storage.removeItem(this.key(previous))
    this.publish(save)
    this.schedule()
  }

  flush() {
    for (const save of this.read()) {
      if (save.state !== "pending") continue
      this.options.storage.setItem(this.key(save), JSON.stringify({ ...save, due: this.now() }))
    }
    this.publish()
    this.schedule()
  }

  retry() {
    for (const save of this.read()) {
      this.options.storage.setItem(this.key(save), JSON.stringify({ ...save, state: "pending", error: undefined, due: this.now() }))
    }
    this.publish()
    this.schedule()
  }

  waitForSaves(householdId: string) {
    this.flush()
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        const jobs = this.jobs.filter(save => save.edit.householdId === householdId)
        const failure = jobs.find(save => save.state !== "pending")
        if (failure) { unsubscribe(); reject(new Error("Your task edits are still waiting to save. Resolve the save notice before continuing.")) }
        else if (!jobs.length) { unsubscribe(); resolve() }
      }
      const unsubscribe = this.subscribe(check)
      check()
    })
  }

  discard(save: TaskSave) {
    this.options.storage.removeItem(this.key(save))
    this.confirmed.delete(this.taskKey(save.edit))
    this.publish()
  }

  /** Overlay reads that began before an acknowledgement, plus every unsaved edit.
   * A read started after the acknowledgement is allowed to show other users' edits.
   */
  overlays(householdId: string, readRevision: number): TaskSave[] {
    const edits = new Map<string, TaskSave>()
    for (const { save, revision } of this.confirmed.values()) {
      if (revision > readRevision && save.edit.householdId === householdId) edits.set(save.edit.taskId, save)
    }
    for (const save of this.jobs) {
      if (save.edit.householdId === householdId) edits.set(save.edit.taskId, save)
    }
    return [...edits.values()]
  }

  private schedule() {
    clearTimeout(this.timer)
    if (!this.active || this.running) return
    const next = this.read().filter(save => save.state !== "error").sort((a, b) => a.due - b.due)[0]
    if (next) this.timer = setTimeout(() => { void this.drain() }, Math.max(0, next.due - this.now()))
  }

  async drain() {
    if (this.running || !this.active) return
    this.running = true
    try {
      // Web Locks also serialize workers in different tabs of this account.
      await this.options.lock(async () => {
        while (this.active) {
          const save = this.read().filter(item => item.state !== "error" && item.due <= this.now()).sort((a, b) => a.due - b.due)[0]
          if (!save) break
          try {
            const task = await this.options.send(save.edit)
            const current = this.read().find(item => this.taskKey(item.edit) === this.taskKey(save.edit))
            if (current?.id !== save.id) continue // A newer edit owns the UI and durable record.
            const confirmed = { ...save, patch: { ...save.patch,
              title: task.title, description: task.description, is_reward: task.is_reward,
              unlock_rule: task.unlock_rule, unlock_at: task.unlock_at, unlock_combiner: task.unlock_combiner,
              expiry_rule: task.expiry_rule, expires_at: task.expires_at,
            } }
            for (const old of this.readRecords()) {
              if (this.taskKey(old.edit) === this.taskKey(save.edit) &&
                (old.created < save.created || (old.created === save.created && old.id.localeCompare(save.id) <= 0))) this.options.storage.removeItem(this.key(old))
            }
            this.confirmed.set(this.taskKey(save.edit), { save: confirmed, revision: this.revision + 1 })
            this.publish(confirmed)
          } catch (error) {
            const current = this.read().find(item => this.taskKey(item.edit) === this.taskKey(save.edit))
            if (current?.id !== save.id) continue
            const retryable = !(error instanceof TaskSaveFailure) || error.status === 408 || error.status === 429 || error.status >= 500
            const attempts = save.attempts + 1
            const failed: TaskSave = { ...save, attempts, state: retryable ? "retrying" : "error",
              error: error instanceof Error ? error.message : "Unable to save changes.",
              due: this.now() + Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)),
            }
            this.options.storage.setItem(this.key(save), JSON.stringify(failed))
            this.publish()
          }
        }
      })
    } finally {
      this.running = false
      this.schedule()
    }
  }
}

type TaskData = {
  tasks: Task[]
  taskAssignees: { task_id: string; user_id: string }[]
  dependencies: { source_task_id: string; target_task_id: string }[]
  allTasks?: { id: string; title: string; is_reward?: boolean }[]
  templateTaskAssignees?: { task_id: string; user_id: string }[]
}

export function overlayTaskEdits<T extends TaskData>(data: T, edits: TaskSave[]): T {
  let result = data
  for (const { edit, patch } of edits) {
    const assignments = edit.assigneeIds.map(user_id => ({ task_id: edit.taskId, user_id }))
    result = { ...result,
      tasks: result.tasks.map(task => task.id === edit.taskId ? { ...task, ...patch } : task),
      allTasks: result.allTasks?.map(task => task.id === edit.taskId ? { ...task, title: patch.title!, is_reward: patch.is_reward } : task),
      taskAssignees: [...result.taskAssignees.filter(row => row.task_id !== edit.taskId), ...assignments],
      templateTaskAssignees: result.templateTaskAssignees && [...result.templateTaskAssignees.filter(row => row.task_id !== edit.taskId), ...assignments],
      dependencies: Array.isArray(edit.prerequisiteIds)
        ? [...result.dependencies.filter(edge => edge.target_task_id !== edit.taskId), ...edit.prerequisiteIds.map(id => ({ source_task_id: String(id), target_task_id: edit.taskId }))]
        : result.dependencies,
    }
  }
  return result
}
