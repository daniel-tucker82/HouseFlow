import { applyRunDraft, savedRunTask, validateRunDraft, validateRunSnapshot, type RunEdit, type RunEditorSnapshot, type RunTaskDraft } from "../../../shared/mobile/run-editor"
import type { HouseholdSummary } from "../../../shared/mobile/contracts"
import { retryDelayMs } from "../../../shared/mobile/sync-policy"
import type { LocalDatabase, SqlConnection } from "./local-store"
import type { PlannerStore } from "./planner-store"

type EditRow = { id: string; account_id: string; household_id: string; device_id: string; revision: number; device_time_ms: number;
  data: string; state: "pending" | "rejected"; attempts: number; next_attempt_ms: number; error: string | null }
type CachedRun = { server: RunEditorSnapshot; view: RunEditorSnapshot }
const draftKey = (householdId: string, occurrenceId: string) => `run-task-draft:${householdId}:${occurrenceId}`
function fromRow(row: EditRow): RunEdit {
  return { id: row.id, accountId: row.account_id, householdId: row.household_id, deviceId: row.device_id, revision: row.revision,
    deviceTimeMs: row.device_time_ms, draft: JSON.parse(row.data), state: row.state, attempts: row.attempts, nextAttemptMs: row.next_attempt_ms, error: row.error }
}

/** Live edits have their own snapshots, drafts and queue, never template storage. */
export class RunEditorStore {
  constructor(private readonly db: LocalDatabase, private readonly planner: PlannerStore) {}
  initialize() {
    return this.db.execAsync(`CREATE TABLE IF NOT EXISTS run_editor_snapshots(account_id TEXT NOT NULL, household_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account_id,household_id,occurrence_id));
      CREATE TABLE IF NOT EXISTS run_editor_edits(account_id TEXT NOT NULL, household_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, task_id TEXT NOT NULL,
        id TEXT NOT NULL, device_id TEXT NOT NULL, revision INTEGER NOT NULL, device_time_ms INTEGER NOT NULL, data TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_ms INTEGER NOT NULL DEFAULT 0,error TEXT,
        PRIMARY KEY(account_id,household_id,occurrence_id,task_id));`)
  }
  allowed(accountId: string, householdId: string, tx: SqlConnection = this.db) { return this.planner.allowed(accountId, householdId, tx) }
  async reconcile(accountId: string, households: HouseholdSummary[], tx: SqlConnection) {
    const allowed = new Set(households.filter(household => household.role !== "member").map(household => household.id))
    const rows = await tx.getAllAsync<{ household_id: string }>(`SELECT household_id FROM run_editor_snapshots WHERE account_id=?
      UNION SELECT household_id FROM run_editor_edits WHERE account_id=?`, accountId, accountId)
    for (const { household_id: householdId } of rows) if (!allowed.has(householdId)) {
      await tx.runAsync("DELETE FROM run_editor_snapshots WHERE account_id=? AND household_id=?", accountId, householdId)
      await tx.runAsync("DELETE FROM device_settings WHERE account_id=? AND setting_key LIKE ?", accountId, `run-task-draft:${householdId}:%`)
      await tx.runAsync("UPDATE run_editor_edits SET state='rejected',error=? WHERE account_id=? AND household_id=?", "You no longer have permission to manage this household.", accountId, householdId)
    }
  }
  async pending(accountId: string, tx: SqlConnection = this.db) {
    return (await tx.getAllAsync<EditRow>("SELECT * FROM run_editor_edits WHERE account_id=? ORDER BY revision", accountId)).map(fromRow)
  }
  private async cached(accountId: string, householdId: string, occurrenceId: string, tx: SqlConnection) {
    const row = await tx.getFirstAsync<{ data: string }>("SELECT data FROM run_editor_snapshots WHERE account_id=? AND household_id=? AND occurrence_id=?", accountId, householdId, occurrenceId)
    return row ? JSON.parse(row.data) as CachedRun : null
  }
  async get(accountId: string, householdId: string, occurrenceId: string) {
    if (!await this.allowed(accountId, householdId)) return null
    return (await this.cached(accountId, householdId, occurrenceId, this.db))?.view ?? null
  }
  private async write(accountId: string, server: RunEditorSnapshot, tx: SqlConnection) {
    if (!await this.allowed(accountId, server.householdId, tx)) throw new Error("Parent access to this household is required.")
    const edits = (await this.pending(accountId, tx)).filter(edit => edit.householdId === server.householdId && edit.draft.occurrenceId === server.occurrence.id)
    const view = edits.reduce((snapshot, edit) => applyRunDraft(snapshot, edit.draft), server)
    await tx.runAsync("INSERT INTO run_editor_snapshots VALUES(?,?,?,?) ON CONFLICT(account_id,household_id,occurrence_id) DO UPDATE SET data=excluded.data",
      accountId, server.householdId, server.occurrence.id, JSON.stringify({ server, view } satisfies CachedRun))
  }
  async cache(accountId: string, householdId: string, occurrenceId: string, snapshot: RunEditorSnapshot) {
    validateRunSnapshot(snapshot, householdId, occurrenceId)
    await this.db.withExclusiveTransactionAsync(async tx => { await this.write(accountId, snapshot, tx) })
  }
  async draft(accountId: string, householdId: string, occurrenceId: string): Promise<RunTaskDraft | null> {
    if (!await this.allowed(accountId, householdId)) return null
    const row = await this.db.getFirstAsync<{ data: string }>("SELECT data FROM device_settings WHERE account_id=? AND setting_key=?", accountId, draftKey(householdId, occurrenceId))
    return row ? JSON.parse(row.data) : null
  }
  async saveDraft(accountId: string, householdId: string, occurrenceId: string, draft: RunTaskDraft | null) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(accountId, householdId, tx)) throw new Error("Parent access to this household is required.")
      const cached = await this.cached(accountId, householdId, occurrenceId, tx)
      if (draft && (!cached || draft.occurrenceId !== occurrenceId || draft.routineId !== cached.server.occurrence.routine_id)) throw new Error("This draft does not belong to the open board.")
      await tx.runAsync("INSERT INTO device_settings VALUES(?,?,?) ON CONFLICT(account_id,setting_key) DO UPDATE SET data=excluded.data", accountId, draftKey(householdId, occurrenceId), JSON.stringify(draft))
    })
  }
  async enqueue(accountId: string, householdId: string, deviceId: string, id: string, draft: RunTaskDraft, deviceTimeMs = Date.now()) {
    validateRunDraft(draft)
    await this.db.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(accountId, householdId, tx)) throw new Error("Parent access to this household is required.")
      const cached = await this.cached(accountId, householdId, draft.occurrenceId, tx)
      if (!cached || cached.server.occurrence.status === "cancelled" || cached.server.occurrence.routine_id !== draft.routineId) throw new Error("Refresh this task board before editing it.")
      const exists = cached.server.tasks.some(task => task.id === draft.taskId)
      if (!draft.isNew && !exists) throw new Error("This task was removed. Refresh the board.")
      if (draft.isNew && exists) throw new Error("This task is already in the board.")
      const prior = (await this.pending(accountId, tx)).find(edit => edit.householdId === householdId && edit.draft.occurrenceId === draft.occurrenceId && edit.draft.taskId === draft.taskId)
      if (prior?.draft.isNew) throw new Error("Wait for this new task to sync, or review its saved request.")
      if (draft.prerequisiteIds.some(id => !cached.server.tasks.some(task => task.id === id))) throw new Error("Prerequisite tasks must finish syncing before they can be selected.")
      const merged = draft.timing === undefined && prior?.draft.timing ? { ...draft, timing: prior.draft.timing,
        unlockAtOverride: prior.draft.unlockAtOverride, expiryAtOverride: prior.draft.expiryAtOverride } : draft
      await tx.runAsync("INSERT INTO device_sequences VALUES(?,?,1) ON CONFLICT(account_id,device_id) DO UPDATE SET sequence=sequence+1", accountId, deviceId)
      const counter = await tx.getFirstAsync<{ sequence: number }>("SELECT sequence FROM device_sequences WHERE account_id=? AND device_id=?", accountId, deviceId)
      if (!counter) throw new Error("Unable to save this task safely.")
      await tx.runAsync(`INSERT INTO run_editor_edits(account_id,household_id,occurrence_id,task_id,id,device_id,revision,device_time_ms,data) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,household_id,occurrence_id,task_id) DO UPDATE SET id=excluded.id,device_id=excluded.device_id,revision=excluded.revision,
          device_time_ms=excluded.device_time_ms,data=excluded.data,state='pending',attempts=0,next_attempt_ms=0,error=NULL`,
        accountId, householdId, draft.occurrenceId, draft.taskId, id, deviceId, counter.sequence, deviceTimeMs, JSON.stringify(merged))
      await this.write(accountId, cached.server, tx)
      await tx.runAsync("DELETE FROM device_settings WHERE account_id=? AND setting_key=?", accountId, draftKey(householdId, draft.occurrenceId))
    })
  }
  async acknowledge(edit: RunEdit, result: unknown) {
    const task = savedRunTask(result, edit)
    await this.db.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(edit.accountId, edit.householdId, tx)) return
      const current = await tx.getFirstAsync("SELECT 1 FROM run_editor_edits WHERE account_id=? AND id=? AND state='pending'", edit.accountId, edit.id)
      const cached = await this.cached(edit.accountId, edit.householdId, edit.draft.occurrenceId, tx)
      if (!current || !cached) return
      // A recovered creation receipt is the original outcome. If a refresh has
      // already loaded this task, preserve that more recent household version.
      const alreadyLoaded = edit.draft.isNew && cached.server.tasks.some(item => item.id === task.id)
      const server = alreadyLoaded ? cached.server : applyRunDraft(cached.server, { ...edit.draft, title: task.title,
        notes: task.description ?? "", isReward: task.is_reward, assigneeIds: task.assignee_ids, prerequisiteIds: task.prerequisite_ids })
      if (!alreadyLoaded) server.tasks = server.tasks.map(item => item.id === task.id ? task : item)
      await tx.runAsync("DELETE FROM run_editor_edits WHERE account_id=? AND id=?", edit.accountId, edit.id)
      await this.write(edit.accountId, server, tx)
    })
  }
  async fail(edit: RunEdit, error: string, rejected: boolean, now = Date.now()) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(edit.accountId, edit.householdId, tx)) return
      await tx.runAsync("UPDATE run_editor_edits SET state=?,error=?,attempts=attempts+1,next_attempt_ms=? WHERE account_id=? AND id=? AND state='pending'",
        rejected ? "rejected" : "pending", error, now + retryDelayMs(edit.attempts), edit.accountId, edit.id)
    })
  }
  async retry(accountId: string, edit: RunEdit) {
    if (accountId !== edit.accountId) throw new Error("Sign back into the account that saved this change.")
    await this.db.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(accountId, edit.householdId, tx)) throw new Error("Parent access to this household is required.")
      await tx.runAsync("UPDATE run_editor_edits SET state='pending',error=NULL,next_attempt_ms=0 WHERE account_id=? AND id=?", accountId, edit.id)
    })
  }
  async discard(accountId: string, edit: RunEdit, fresh: RunEditorSnapshot | null) {
    if (accountId !== edit.accountId) throw new Error("Sign back into the account that saved this change.")
    if (fresh) validateRunSnapshot(fresh, edit.householdId, edit.draft.occurrenceId)
    await this.db.withExclusiveTransactionAsync(async tx => {
      const row = await tx.getFirstAsync("SELECT 1 FROM run_editor_edits WHERE account_id=? AND id=? AND state='rejected'", accountId, edit.id)
      if (!row) return
      const allowed = await this.allowed(accountId, edit.householdId, tx), cached = await this.cached(accountId, edit.householdId, edit.draft.occurrenceId, tx)
      if (allowed && cached && !fresh && !edit.draft.isNew) throw new Error("Connect to refresh this board before discarding a saved edit.")
      await tx.runAsync("DELETE FROM run_editor_edits WHERE account_id=? AND id=?", accountId, edit.id)
      if (allowed && (fresh || cached)) await this.write(accountId, fresh ?? cached!.server, tx)
    })
  }
  async remove(accountId: string, householdId: string, occurrenceId: string, tx: SqlConnection) {
    await tx.runAsync("DELETE FROM run_editor_snapshots WHERE account_id=? AND household_id=? AND occurrence_id=?", accountId, householdId, occurrenceId)
    await tx.runAsync("DELETE FROM device_settings WHERE account_id=? AND setting_key=?", accountId, draftKey(householdId, occurrenceId))
    await tx.runAsync("UPDATE run_editor_edits SET state='rejected',error=? WHERE account_id=? AND household_id=? AND occurrence_id=?", "This task board is no longer available.", accountId, householdId, occurrenceId)
  }
  invalidate(accountId: string, householdId: string, occurrenceId: string) {
    return this.db.withExclusiveTransactionAsync(tx => this.remove(accountId, householdId, occurrenceId, tx))
  }
  async removeTask(accountId: string, householdId: string, occurrenceId: string, taskId: string, tx: SqlConnection) {
    // A confirmed deletion also resolves a lost creation receipt for this ID.
    // Do not let that optimistic placeholder reappear in a later refresh.
    for (const edit of await this.pending(accountId, tx)) if (edit.householdId === householdId && edit.draft.occurrenceId === occurrenceId && edit.draft.taskId === taskId && edit.draft.isNew) {
      await tx.runAsync("DELETE FROM run_editor_edits WHERE account_id=? AND id=?", accountId, edit.id)
    }
    const draft = await tx.getFirstAsync<{ data: string }>("SELECT data FROM device_settings WHERE account_id=? AND setting_key=?", accountId, draftKey(householdId, occurrenceId))
    if (draft && (JSON.parse(draft.data) as RunTaskDraft | null)?.taskId === taskId) {
      await tx.runAsync("DELETE FROM device_settings WHERE account_id=? AND setting_key=?", accountId, draftKey(householdId, occurrenceId))
    }
    const cached = await this.cached(accountId, householdId, occurrenceId, tx)
    if (cached) await this.write(accountId, { ...cached.server, tasks: cached.server.tasks.filter(task => task.id !== taskId),
      dependencies: cached.server.dependencies.filter(edge => edge.source_task_id !== taskId && edge.target_task_id !== taskId),
      taskAssignees: cached.server.taskAssignees.filter(row => row.task_id !== taskId) }, tx)
    await tx.runAsync("UPDATE run_editor_edits SET state='rejected',error=? WHERE account_id=? AND household_id=? AND occurrence_id=? AND task_id=?", "This task was removed from the board.", accountId, householdId, occurrenceId, taskId)
  }
}
