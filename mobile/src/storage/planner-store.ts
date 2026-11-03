import type { HouseholdSummary } from "../../../shared/mobile/contracts"
import { applyPlannerDraft, validatePlannerDraft, type PlannerCreation, type PlannerEdit, type PlannerSnapshot, type PlannerTaskDraft } from "../../../shared/mobile/planner"
import { retryDelayMs } from "../../../shared/mobile/sync-policy"
import type { LocalDatabase, SqlConnection } from "./local-store"

type EditRow = { id: string; account_id: string; household_id: string; device_id: string; revision: number; data: string;
  state: "pending" | "rejected"; attempts: number; next_attempt_ms: number; error: string | null }
type CachedPlanner = { server: PlannerSnapshot; view: PlannerSnapshot }
function editFromRow(row: EditRow): PlannerEdit {
  return { id: row.id, accountId: row.account_id, householdId: row.household_id, deviceId: row.device_id, revision: row.revision,
    draft: JSON.parse(row.data), state: row.state, attempts: row.attempts, nextAttemptMs: row.next_attempt_ms, error: row.error }
}

/** Account-scoped planner edits survive navigation, process death and lost replies. */
export class PlannerStore {
  constructor(private readonly database: LocalDatabase) {}
  async initialize() {
    await this.database.execAsync(`
      CREATE TABLE IF NOT EXISTS planner_access (account_id TEXT NOT NULL, household_id TEXT NOT NULL, allowed INTEGER NOT NULL,
        PRIMARY KEY(account_id,household_id));
      CREATE TABLE IF NOT EXISTS planner_snapshots (account_id TEXT NOT NULL, household_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(account_id,household_id));
      CREATE TABLE IF NOT EXISTS planner_edits (account_id TEXT NOT NULL, household_id TEXT NOT NULL, task_id TEXT NOT NULL,
        id TEXT NOT NULL, device_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0, error TEXT,
        PRIMARY KEY(account_id,household_id,task_id));
      CREATE TABLE IF NOT EXISTS planner_creations (account_id TEXT NOT NULL, household_id TEXT NOT NULL, id TEXT NOT NULL,
        label TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0, error TEXT,
        PRIMARY KEY(account_id,id));
    `)
  }
  async reconcile(accountId: string, households: HouseholdSummary[], tx: SqlConnection) {
    const allowed = new Set(households.filter(household => household.role !== "member").map(household => household.id))
    const known = await tx.getAllAsync<{ household_id: string }>(`SELECT household_id FROM planner_access WHERE account_id = ?
      UNION SELECT household_id FROM planner_edits WHERE account_id = ?
      UNION SELECT household_id FROM planner_creations WHERE account_id = ?`, accountId, accountId, accountId)
    for (const householdId of new Set([...allowed, ...known.map(row => row.household_id)])) {
      await tx.runAsync(`INSERT INTO planner_access VALUES (?, ?, ?) ON CONFLICT(account_id,household_id) DO UPDATE SET allowed=excluded.allowed`,
        accountId, householdId, allowed.has(householdId) ? 1 : 0)
      if (!allowed.has(householdId)) {
        await tx.runAsync("DELETE FROM planner_snapshots WHERE account_id=? AND household_id=?", accountId, householdId)
        await tx.runAsync("UPDATE planner_edits SET state='rejected',error=? WHERE account_id=? AND household_id=?",
          "You no longer have permission to manage this household.", accountId, householdId)
        await tx.runAsync("UPDATE planner_creations SET state='rejected',error=? WHERE account_id=? AND household_id=?",
          "You no longer have permission to manage this household.", accountId, householdId)
      }
    }
  }
  async allowed(accountId: string, householdId: string, tx: SqlConnection = this.database) {
    return Boolean((await tx.getFirstAsync<{ allowed: number }>("SELECT allowed FROM planner_access WHERE account_id=? AND household_id=?", accountId, householdId))?.allowed)
  }
  private async cached(accountId: string, householdId: string, tx: SqlConnection) {
    const row = await tx.getFirstAsync<{ data: string }>("SELECT data FROM planner_snapshots WHERE account_id=? AND household_id=?", accountId, householdId)
    return row ? JSON.parse(row.data) as CachedPlanner : null
  }
  async get(accountId: string, householdId: string) { return (await this.cached(accountId, householdId, this.database))?.view ?? null }
  async pending(accountId: string, tx: SqlConnection = this.database) {
    return (await tx.getAllAsync<EditRow>("SELECT * FROM planner_edits WHERE account_id=? ORDER BY revision", accountId)).map(editFromRow)
  }
  private async write(accountId: string, householdId: string, server: PlannerSnapshot, tx: SqlConnection) {
    const edits = (await this.pending(accountId, tx)).filter(edit => edit.householdId === householdId)
    const view = edits.reduce((snapshot, edit) => applyPlannerDraft(snapshot, edit.draft), server)
    await tx.runAsync(`INSERT INTO planner_snapshots VALUES (?, ?, ?) ON CONFLICT(account_id,household_id) DO UPDATE SET data=excluded.data`,
      accountId, householdId, JSON.stringify({ server, view } satisfies CachedPlanner))
    return view
  }
  async cache(accountId: string, householdId: string, server: PlannerSnapshot) {
    if (server.householdId !== householdId) throw new Error("Unexpected household response.")
    await this.database.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(accountId, householdId, tx)) throw new Error("You no longer have permission to manage this household.")
      await this.write(accountId, householdId, server, tx)
    })
  }
  async enqueue(accountId: string, householdId: string, deviceId: string, id: string, draft: PlannerTaskDraft) {
    validatePlannerDraft(draft)
    if (draft.isNew) throw new Error("Connect to add a new task.")
    await this.database.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(accountId, householdId, tx)) throw new Error("You no longer have permission to manage this household.")
      const cached = await this.cached(accountId, householdId, tx)
      if (!cached?.view.tasks.some(task => task.id === draft.taskId && task.routine_id === draft.routineId)) throw new Error("This task was removed. Refresh the routine.")
      await tx.runAsync(`INSERT INTO device_sequences VALUES (?, ?, 1) ON CONFLICT(account_id,device_id) DO UPDATE SET sequence=sequence+1`, accountId, deviceId)
      const counter = await tx.getFirstAsync<{ sequence: number }>("SELECT sequence FROM device_sequences WHERE account_id=? AND device_id=?", accountId, deviceId)
      if (!counter) throw new Error("Unable to save this edit safely.")
      await tx.runAsync(`INSERT INTO planner_edits(account_id,household_id,task_id,id,device_id,revision,data) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(account_id,household_id,task_id) DO UPDATE SET id=excluded.id,device_id=excluded.device_id,revision=excluded.revision,
          data=excluded.data,state='pending',attempts=0,next_attempt_ms=0,error=NULL`, accountId, householdId, draft.taskId, id, deviceId, counter.sequence, JSON.stringify(draft))
      await this.write(accountId, householdId, cached.server, tx)
      await tx.runAsync("DELETE FROM device_settings WHERE account_id=? AND setting_key=?", accountId, `planner-task-draft:${householdId}`)
    })
  }
  async acknowledge(edit: PlannerEdit) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      // A reply for the previous edit cannot erase the replacement queued during upload.
      await tx.runAsync("DELETE FROM planner_edits WHERE account_id=? AND id=?", edit.accountId, edit.id)
      const cached = await this.cached(edit.accountId, edit.householdId, tx)
      if (cached) await this.write(edit.accountId, edit.householdId, applyPlannerDraft(cached.server, edit.draft), tx)
    })
  }
  async fail(edit: PlannerEdit, error: string, rejected: boolean, now: number) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      // A late network failure cannot re-enable an upload revoked during flight.
      if (!await this.allowed(edit.accountId, edit.householdId, tx)) return
      await tx.runAsync(`UPDATE planner_edits SET state=?,error=?,attempts=attempts+1,next_attempt_ms=? WHERE account_id=? AND id=?`,
        rejected ? "rejected" : "pending", error, now + retryDelayMs(edit.attempts), edit.accountId, edit.id)
    })
  }
  async retry(accountId: string, edit: PlannerEdit) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(accountId, edit.householdId, tx)) throw new Error("You no longer have permission to manage this household.")
      await tx.runAsync("UPDATE planner_edits SET state='pending',error=NULL,next_attempt_ms=0 WHERE account_id=? AND id=?", accountId, edit.id)
    })
  }
  async discard(accountId: string, edit: PlannerEdit, fresh: PlannerSnapshot | null) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      const allowed = await this.allowed(accountId, edit.householdId, tx)
      if (fresh && fresh.householdId !== edit.householdId) throw new Error("Unexpected household response.")
      if (allowed && !fresh) throw new Error("Connect to refresh the routine before discarding this edit.")
      const current = await tx.getFirstAsync("SELECT id FROM planner_edits WHERE account_id=? AND id=? AND state='rejected'", accountId, edit.id)
      if (!current) return
      await tx.runAsync("DELETE FROM planner_edits WHERE account_id=? AND id=? AND state='rejected'", accountId, edit.id)
      if (allowed && fresh) await this.write(accountId, edit.householdId, fresh, tx)
    })
  }
  async creations(accountId: string) {
    type Row = { id: string; account_id: string; household_id: string; label: string; body: string; state: "pending" | "rejected"; attempts: number; next_attempt_ms: number; error: string | null }
    return (await this.database.getAllAsync<Row>("SELECT * FROM planner_creations WHERE account_id=? ORDER BY rowid", accountId)).map(row => ({
      id: row.id, accountId: row.account_id, householdId: row.household_id, label: row.label, body: JSON.parse(row.body),
      state: row.state, attempts: row.attempts, nextAttemptMs: row.next_attempt_ms, error: row.error,
    } satisfies PlannerCreation))
  }
  async enqueueCreation(creation: PlannerCreation) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(creation.accountId, creation.householdId, tx)) throw new Error("You no longer have permission to manage this household.")
      // Immutable payload: a retry must never change the meaning of its ID.
      await tx.runAsync("INSERT INTO planner_creations(account_id,household_id,id,label,body) VALUES(?,?,?,?,?)",
        creation.accountId, creation.householdId, creation.id, creation.label, JSON.stringify(creation.body))
      if (creation.body.action === "createTask") {
        // Clear the unfinished form atomically with its durable submission.
        await tx.runAsync("DELETE FROM device_settings WHERE account_id=? AND setting_key=?", creation.accountId, `planner-task-draft:${creation.householdId}`)
      }
    })
  }
  async acknowledgeCreation(accountId: string, id: string) {
    await this.database.runAsync("DELETE FROM planner_creations WHERE account_id=? AND id=?", accountId, id)
  }
  async failCreation(creation: PlannerCreation, error: string, rejected: boolean, now: number) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(creation.accountId, creation.householdId, tx)) return
      await tx.runAsync("UPDATE planner_creations SET state=?,error=?,attempts=attempts+1,next_attempt_ms=? WHERE account_id=? AND id=?",
        rejected ? "rejected" : "pending", error, now + retryDelayMs(creation.attempts), creation.accountId, creation.id)
    })
  }
  async retryCreation(accountId: string, creation: PlannerCreation) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      if (!await this.allowed(accountId, creation.householdId, tx)) throw new Error("You no longer have permission to manage this household.")
      await tx.runAsync("UPDATE planner_creations SET state='pending',error=NULL,next_attempt_ms=0 WHERE account_id=? AND id=?", accountId, creation.id)
    })
  }
  async discardCreation(accountId: string, id: string) {
    // An uncertain network outcome stays queued until the server resolves it.
    await this.database.runAsync("DELETE FROM planner_creations WHERE account_id=? AND id=? AND state='rejected'", accountId, id)
  }
}
