import type { BoardSnapshot, CompletionChange, CompletionResult, HouseholdSummary } from "../../../shared/mobile/contracts"
import { retryDelayMs } from "../../../shared/mobile/sync-policy"
import { PlannerStore } from "./planner-store"
import { RunEditorStore } from "./run-editor-store"
import { NotificationStore } from "./notification-store"
import { NotificationSessionStore } from "./notification-session-store"
import { NotificationInbox } from "./notification-inbox"
import { NotificationHistoryStore } from "./notification-history-store"
import { BillingStore } from "./billing-store"
import { AccountDeletionStore } from "./account-deletion-store"
import { AccountDeletionLocalStore } from "./account-deletion-local"
import { BillingIdentityStore } from "./billing-identity-store"
import { KioskStore, kioskRestriction, requireKioskParentAccess } from "./kiosk-store"
import { restrictKioskBoard } from "../../../shared/mobile/kiosk"
import { parseBoardDisplay, type BoardDisplayPreferences } from "../../../shared/mobile/board-view"
import { mergeRunPages, runView, summarizeRun, type RunPage, type RunSnapshot, type RunSummary, type RunView } from "../../../shared/mobile/runs"

export type SqlValue = string | number | null
export interface SqlConnection {
  execAsync(sql: string): Promise<void>
  runAsync(sql: string, ...parameters: SqlValue[]): Promise<unknown>
  getFirstAsync<T>(sql: string, ...parameters: SqlValue[]): Promise<T | null>
  getAllAsync<T>(sql: string, ...parameters: SqlValue[]): Promise<T[]>
}
export interface LocalDatabase extends SqlConnection {
  withExclusiveTransactionAsync(work: (transaction: SqlConnection) => Promise<void>): Promise<void>
}

type PendingRow = {
  id: string; account_id: string; household_id: string; device_id: string; task_id: string;
  occurrence_id: string; member_id: string; completed: number; device_time_ms: number; sequence: number;
  corrected_time_ms: number | null; attempts: number; next_attempt_ms: number;
  state: "pending" | "rejected"; error: string | null;
}

function fromRow(row: PendingRow): CompletionChange {
  return {
    id: row.id, accountId: row.account_id, householdId: row.household_id, deviceId: row.device_id,
    taskId: row.task_id, occurrenceId: row.occurrence_id, memberId: row.member_id, completed: row.completed === 1,
    deviceTimeMs: row.device_time_ms, sequence: row.sequence, correctedTimeMs: row.corrected_time_ms,
    attempts: row.attempts, nextAttemptMs: row.next_attempt_ms, state: row.state, error: row.error,
  }
}

function overlayChanges(snapshot: BoardSnapshot, changes: CompletionChange[]): BoardSnapshot {
  const byTask = new Map(changes.map(change => [`${change.occurrenceId}:${change.taskId}`, change]))
  return { ...snapshot, tasks: snapshot.tasks.map(task => {
    const change = byTask.get(`${task.occurrence_id}:${task.id}`)
    return change ? { ...task, status: change.completed ? "completed" : "unlocked" } : task
  }) }
}

// Keep the server base as well as the materialized screen. Removing an optimistic
// edit must reveal the latest server value, even if its acknowledgement is older.
type CachedBoard = { format: 3; server: BoardSnapshot; board: BoardSnapshot }
function readCachedBoard(data: string): CachedBoard {
  const cached = JSON.parse(data) as CachedBoard | BoardSnapshot
  if ("format" in cached && cached.format === 3) return cached
  // Legacy snapshots already contain pending edits. Preserve them until a server
  // refresh/acknowledgement supplies a versioned base; never discard their outbox.
  return { format: 3, server: cached as BoardSnapshot, board: cached as BoardSnapshot }
}

function statusVersion(task: { status_version?: string }) {
  return typeof task.status_version === "string" && /^\d+$/.test(task.status_version) ? BigInt(task.status_version) : 0n
}

function mergeServerBoard(incoming: BoardSnapshot, previous?: BoardSnapshot): BoardSnapshot {
  const prior = new Map(previous?.tasks.map(task => [`${task.occurrence_id}:${task.id}`, task]))
  return { ...incoming, tasks: incoming.tasks.map(task => {
    const old = prior.get(`${task.occurrence_id}:${task.id}`)
    // Keep fresh metadata, but never roll back a status learned from a newer
    // server response. Missing tasks stay missing; acknowledgements cannot add them.
    return old && statusVersion(old) > statusVersion(task) ? { ...task, status: old.status,
      status_version: old.status_version, lock_type: old.lock_type, blocking_task_title: old.blocking_task_title } : task
  }) }
}

function acknowledged<T extends BoardSnapshot>(server: T, occurrenceId: string, result: CompletionResult): T {
  const statuses = new Map(result.occurrenceTaskStatuses.map(item => [item.task_id, item]))
  return { ...server, tasks: server.tasks.map(task => {
    const incoming = task.occurrence_id === occurrenceId ? statuses.get(task.id) : undefined
    return incoming && statusVersion(incoming) >= statusVersion(task) ? { ...task, status: incoming.status, status_version: incoming.status_version } : task
  }) }
}

/** The device database is the durable outbox. Network callbacks never own it. */
export class LocalStore {
  readonly planner: PlannerStore
  readonly runEditor: RunEditorStore
  readonly notifications: NotificationStore
  readonly notificationSessions: NotificationSessionStore
  readonly notificationInbox: NotificationInbox
  readonly notificationHistory: NotificationHistoryStore
  readonly kiosk: KioskStore
  readonly billing: BillingStore
  readonly accountDeletion: AccountDeletionStore
  readonly deletedAccounts: AccountDeletionLocalStore
  readonly billingIdentity: BillingIdentityStore
  constructor(private readonly database: LocalDatabase) { this.planner = new PlannerStore(database); this.runEditor = new RunEditorStore(database, this.planner); this.notifications = new NotificationStore(database); this.notificationSessions = new NotificationSessionStore(database); this.notificationInbox = new NotificationInbox(database); this.notificationHistory = new NotificationHistoryStore(database); this.kiosk = new KioskStore(database); this.billing = new BillingStore(database); this.accountDeletion = new AccountDeletionStore(database); this.deletedAccounts = new AccountDeletionLocalStore(database); this.billingIdentity = new BillingIdentityStore(database) }

  async initialize() {
    await this.database.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS board_snapshots (
        account_id TEXT NOT NULL, household_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (account_id, household_id)
      );
      CREATE TABLE IF NOT EXISTS device_sequences (
        account_id TEXT NOT NULL, device_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        PRIMARY KEY (account_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS pending_completions (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, household_id TEXT NOT NULL, device_id TEXT NOT NULL,
        task_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, member_id TEXT NOT NULL,
        completed INTEGER NOT NULL CHECK(completed IN (0,1)), device_time_ms INTEGER NOT NULL,
        sequence INTEGER NOT NULL, corrected_time_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_ms INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', error TEXT,
        UNIQUE(account_id, device_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS pending_by_account ON pending_completions(account_id, state, sequence);
      CREATE TABLE IF NOT EXISTS device_settings (
        account_id TEXT NOT NULL, setting_key TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(account_id, setting_key)
      );
      CREATE TABLE IF NOT EXISTS revoked_households (
        account_id TEXT NOT NULL, household_id TEXT NOT NULL,
        PRIMARY KEY(account_id, household_id)
      );
      CREATE TABLE IF NOT EXISTS run_snapshots (
        account_id TEXT NOT NULL, household_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(account_id,household_id,occurrence_id)
      );
      CREATE TABLE IF NOT EXISTS run_pages (
        account_id TEXT NOT NULL, household_id TEXT NOT NULL, view TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(account_id,household_id,view)
      );
    `)
    await this.kiosk.initialize()
    await this.planner.initialize()
    await this.runEditor.initialize()
    await this.notifications.initialize()
    await this.notificationSessions.initialize()
    await this.notificationInbox.initialize()
    await this.notificationHistory.initialize()
    await this.billing.initialize()
    await this.accountDeletion.initialize()
    await this.deletedAccounts.initialize()
    await this.billingIdentity.initialize()
    await this.database.execAsync("PRAGMA user_version = 15;")
  }

  async getBoard(accountId: string, householdId: string, connection: SqlConnection = this.database) {
    return (await this.getCachedBoard(accountId, householdId, connection))?.board ?? null
  }

  private async getCachedBoard(accountId: string, householdId: string, connection: SqlConnection) {
    const row = await connection.getFirstAsync<{ data: string }>(
      "SELECT data FROM board_snapshots WHERE account_id = ? AND household_id = ?", accountId, householdId)
    return row ? readCachedBoard(row.data) : null
  }

  async getBoards(accountId: string) {
    const rows = await this.database.getAllAsync<{ data: string }>("SELECT data FROM board_snapshots WHERE account_id = ?", accountId)
    return rows.map(row => readCachedBoard(row.data).board)
  }

  async pending(accountId: string, connection: SqlConnection = this.database) {
    return (await connection.getAllAsync<PendingRow>(
      "SELECT * FROM pending_completions WHERE account_id = ? ORDER BY sequence", accountId)).map(fromRow)
  }

  private async writeBoard(connection: SqlConnection, accountId: string, server: BoardSnapshot) {
    const kiosk = await kioskRestriction(connection)
    if (kiosk) {
      const restricted = accountId === kiosk.accountId ? restrictKioskBoard(server, kiosk) : null
      if (!restricted) throw new Error("Unlock kiosk mode to access another household.")
      server = restricted
    }
    const pending = (await this.pending(accountId, connection)).filter(change => change.householdId === server.household.id)
    const cached: CachedBoard = { format: 3, server, board: overlayChanges(server, pending) }
    await connection.runAsync(`INSERT INTO board_snapshots(account_id, household_id, data) VALUES (?, ?, ?)
      ON CONFLICT(account_id, household_id) DO UPDATE SET data = excluded.data`,
    accountId, server.household.id, JSON.stringify(cached))
    return cached.board
  }

  async cacheBoard(accountId: string, snapshot: BoardSnapshot) {
    let merged = snapshot
    await this.database.withExclusiveTransactionAsync(async transaction => {
      if (await this.isHouseholdRevoked(accountId, snapshot.household.id, transaction)) {
        throw new Error("Access to this household has been removed.")
      }
      const previous = await this.getCachedBoard(accountId, snapshot.household.id, transaction)
      // A refresh cannot erase an edit created while the request was in flight.
      merged = await this.writeBoard(transaction, accountId, mergeServerBoard(snapshot, previous?.server))
      // Keep an opened run current when Today learns newer task states.
      for (const cached of await this.runCaches(accountId, snapshot.household.id, transaction, [...new Set(snapshot.tasks.map(task => task.occurrence_id))])) {
        const tasks = snapshot.tasks.filter(task => task.occurrence_id === cached.server.run.id)
        if (tasks.length) await this.writeRun(transaction, accountId, { ...cached.server, household: snapshot.household, members: snapshot.members,
          tasks: mergeServerBoard({ ...snapshot, tasks }, cached.server).tasks })
      }
    })
    return merged
  }

  private async runCaches(accountId: string, householdId: string, tx: SqlConnection, ids?: string[]) {
    if (ids && !ids.length) return []
    return (await tx.getAllAsync<{ data: string }>(`SELECT data FROM run_snapshots WHERE account_id=? AND household_id=?${ids ? ` AND occurrence_id IN (${ids.map(() => "?").join(",")})` : ""}`, accountId, householdId, ...(ids ?? [])))
      .map(row => JSON.parse(row.data) as { server: RunSnapshot; board: RunSnapshot })
  }
  private async runCache(accountId: string, householdId: string, occurrenceId: string, tx: SqlConnection) {
    const row = await tx.getFirstAsync<{ data: string }>("SELECT data FROM run_snapshots WHERE account_id=? AND household_id=? AND occurrence_id=?", accountId, householdId, occurrenceId)
    return row ? JSON.parse(row.data) as { server: RunSnapshot; board: RunSnapshot } : null
  }
  async getRun(accountId: string, householdId: string, occurrenceId: string) { return (await this.runCache(accountId, householdId, occurrenceId, this.database))?.board ?? null }
  private async updateRunPages(tx: SqlConnection, accountId: string, householdId: string, run: RunSummary) {
    const rows = await tx.getAllAsync<{ data: string }>("SELECT data FROM run_pages WHERE account_id=? AND household_id=?", accountId, householdId)
    for (const row of rows) {
      const page = JSON.parse(row.data) as RunPage
      page.items = page.items.filter(item => item.id !== run.id)
      if (runView(run) === page.view) page.items.push(run)
      page.items.sort((a, b) => b.scheduled_for.localeCompare(a.scheduled_for) || b.id.localeCompare(a.id))
      await tx.runAsync("UPDATE run_pages SET data=? WHERE account_id=? AND household_id=? AND view=?", JSON.stringify(page), accountId, householdId, page.view)
    }
  }
  private async writeRun(tx: SqlConnection, accountId: string, server: RunSnapshot) {
    await requireKioskParentAccess(tx)
    server = summarizeRun(server)
    const changes = (await this.pending(accountId, tx)).filter(change => change.householdId === server.household.id)
    const board = summarizeRun({ ...server, ...overlayChanges(server, changes) })
    await tx.runAsync("INSERT INTO run_snapshots VALUES(?,?,?,?) ON CONFLICT(account_id,household_id,occurrence_id) DO UPDATE SET data=excluded.data",
      accountId, server.household.id, server.run.id, JSON.stringify({ server, board }))
    await this.updateRunPages(tx, accountId, server.household.id, board.run)
    return board
  }
  async cacheRun(accountId: string, snapshot: RunSnapshot) {
    if (snapshot.tasks.some(task => task.occurrence_id !== snapshot.run.id)) throw new Error("This run response contained unrelated tasks.")
    await this.database.withExclusiveTransactionAsync(async tx => {
      if (await this.isHouseholdRevoked(accountId, snapshot.household.id, tx)) throw new Error("Access to this household has been removed.")
      const previous = await this.runCache(accountId, snapshot.household.id, snapshot.run.id, tx)
      await this.writeRun(tx, accountId, { ...snapshot, ...mergeServerBoard(snapshot, previous?.server) })
      const today = await this.getCachedBoard(accountId, snapshot.household.id, tx)
      if (today) {
        const tasks = new Map(snapshot.tasks.map(task => [task.id, task]))
        await this.writeBoard(tx, accountId, mergeServerBoard({ ...today.server, tasks: today.server.tasks.map(task => task.occurrence_id === snapshot.run.id ? tasks.get(task.id) ?? task : task) }, today.server))
      }
    })
  }
  async getRunPage(accountId: string, householdId: string, view: RunView, tx: SqlConnection = this.database): Promise<RunPage | null> {
    const row = await tx.getFirstAsync<{ data: string }>("SELECT data FROM run_pages WHERE account_id=? AND household_id=? AND view=?", accountId, householdId, view)
    return row ? JSON.parse(row.data) : null
  }
  async cacheRunPage(accountId: string, page: RunPage, append = false) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      await requireKioskParentAccess(tx)
      if (await this.isHouseholdRevoked(accountId, page.householdId, tx)) throw new Error("Access to this household has been removed.")
      const previous = append ? await this.getRunPage(accountId, page.householdId, page.view, tx) : null
      const merged = previous ? mergeRunPages(previous, page) : page
      await tx.runAsync("INSERT INTO run_pages VALUES(?,?,?,?) ON CONFLICT(account_id,household_id,view) DO UPDATE SET data=excluded.data", accountId, page.householdId, page.view, JSON.stringify(merged))
      const pending = await this.pending(accountId, tx)
      const ids = [...new Set(pending.filter(change => change.householdId === page.householdId).map(change => change.occurrenceId))]
      for (const run of await this.runCaches(accountId, page.householdId, tx, ids)) {
        await this.updateRunPages(tx, accountId, page.householdId, run.board.run)
      }
    })
  }
  async removeRun(accountId: string, householdId: string, occurrenceId: string) {
    await this.database.withExclusiveTransactionAsync(tx => this.removeRunInTransaction(tx, accountId, householdId, occurrenceId))
  }
  async removeRunTask(accountId: string, householdId: string, occurrenceId: string, taskId: string) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      if (!await this.runEditor.allowed(accountId, householdId, tx)) throw new Error("Parent access to this household is required.")
      await this.runEditor.removeTask(accountId, householdId, occurrenceId, taskId, tx)
      await tx.runAsync("UPDATE pending_completions SET state='rejected',error=? WHERE account_id=? AND household_id=? AND occurrence_id=? AND task_id=?", "This task was removed from the board.", accountId, householdId, occurrenceId, taskId)
      const cached = await this.runCache(accountId, householdId, occurrenceId, tx)
      if (cached) await this.writeRun(tx, accountId, { ...cached.server, tasks: cached.server.tasks.filter(task => task.id !== taskId) })
      const today = await this.getCachedBoard(accountId, householdId, tx)
      if (today) await this.writeBoard(tx, accountId, { ...today.server, tasks: today.server.tasks.filter(task => task.id !== taskId || task.occurrence_id !== occurrenceId) })
    })
  }
  /** Apply a confirmed rename to every cached view without changing task state. */
  async renameRun(accountId: string, householdId: string, occurrenceId: string, title: string) {
    if (!title.trim()) throw new Error("Enter a name for this run.")
    await this.database.withExclusiveTransactionAsync(async tx => {
      await requireKioskParentAccess(tx)
      if (await this.isHouseholdRevoked(accountId, householdId, tx)) throw new Error("Access to this household has been removed.")
      const rename = <T extends BoardSnapshot>(snapshot: T): T => ({ ...snapshot,
        tasks: snapshot.tasks.map(task => task.occurrence_id === occurrenceId ? { ...task, occurrence_title: title } : task) })
      const cached = await this.runCache(accountId, householdId, occurrenceId, tx)
      if (cached) await this.writeRun(tx, accountId, { ...rename(cached.server), run: { ...cached.server.run, title } })
      for (const view of ["active", "past"] as const) {
        const page = await this.getRunPage(accountId, householdId, view, tx)
        if (page) await tx.runAsync("UPDATE run_pages SET data=? WHERE account_id=? AND household_id=? AND view=?",
          JSON.stringify({ ...page, items: page.items.map(run => run.id === occurrenceId ? { ...run, title } : run) }), accountId, householdId, view)
      }
      const today = await this.getCachedBoard(accountId, householdId, tx)
      if (today) await this.writeBoard(tx, accountId, rename(today.server))
    })
  }
  private async removeRunInTransaction(tx: SqlConnection, accountId: string, householdId: string, occurrenceId: string) {
    await this.runEditor.remove(accountId, householdId, occurrenceId, tx)
    await tx.runAsync("DELETE FROM run_snapshots WHERE account_id=? AND household_id=? AND occurrence_id=?", accountId, householdId, occurrenceId)
    for (const view of ["active", "past"] as const) {
      const page = await this.getRunPage(accountId, householdId, view, tx)
      if (page) await tx.runAsync("UPDATE run_pages SET data=? WHERE account_id=? AND household_id=? AND view=?", JSON.stringify({ ...page, items: page.items.filter(item => item.id !== occurrenceId) }), accountId, householdId, view)
    }
    // Keep unsent intent available for review, but stop uploading it to a run
    // the server has confirmed is unavailable. A reused task ID in another run
    // and another account's caches are unaffected.
    await tx.runAsync("UPDATE pending_completions SET state='rejected',error=? WHERE account_id=? AND household_id=? AND occurrence_id=?",
      "This run is no longer available. Its saved changes cannot be applied.", accountId, householdId, occurrenceId)
    const today = await this.getCachedBoard(accountId, householdId, tx)
    if (today) await this.writeBoard(tx, accountId, { ...today.server, tasks: today.server.tasks.filter(task => task.occurrence_id !== occurrenceId) })
  }

  private async revokeKioskHousehold(transaction: SqlConnection, accountId: string, householdId: string) {
    await transaction.runAsync("INSERT OR IGNORE INTO revoked_households(account_id,household_id) VALUES(?,?)", accountId, householdId)
    await transaction.runAsync("DELETE FROM board_snapshots WHERE account_id=? AND household_id=?", accountId, householdId)
    await transaction.runAsync("UPDATE pending_completions SET state='rejected',error=? WHERE account_id=? AND household_id=?", "Parent access to this household changed. Kiosk mode remains locked.", accountId, householdId)
  }
  /** An authenticated kiosk denial clears only the still-restricted household. */
  async invalidateKioskAccess(accountId: string, householdId: string | undefined) {
    await this.database.withExclusiveTransactionAsync(async transaction => {
      const kiosk = await kioskRestriction(transaction)
      if (kiosk?.accountId === accountId && kiosk.householdId === householdId) await this.revokeKioskHousehold(transaction, accountId, householdId)
    })
  }
  /** Only an authoritative membership response can invalidate an offline cache. */
  async reconcileHouseholds(accountId: string, households: HouseholdSummary[]) {
    await this.database.withExclusiveTransactionAsync(async transaction => {
      const kiosk = await kioskRestriction(transaction)
      if (kiosk) {
        if (accountId !== kiosk.accountId) throw new Error("Unlock kiosk mode before switching accounts.")
        const household = households.find(item => item.id === kiosk.householdId)
        if (!household || household.role !== "manager") {
          await this.revokeKioskHousehold(transaction, accountId, kiosk.householdId)
        } else await transaction.runAsync("DELETE FROM revoked_households WHERE account_id=? AND household_id=?", accountId, kiosk.householdId)
        return
      }
      await this.notifications.reconcile(accountId, households, transaction)
      await this.notificationHistory.reconcile(accountId, households, transaction)
      await this.planner.reconcile(accountId, households, transaction)
      await this.runEditor.reconcile(accountId, households, transaction)
      const allowed = new Map(households.map(household => [household.id, household]))
      const known = await transaction.getAllAsync<{ household_id: string }>(`
        SELECT household_id FROM board_snapshots WHERE account_id = ?
        UNION SELECT household_id FROM pending_completions WHERE account_id = ?
        UNION SELECT household_id FROM run_snapshots WHERE account_id = ?
        UNION SELECT household_id FROM run_pages WHERE account_id = ?`, accountId, accountId, accountId, accountId)
      for (const household of households) {
        await transaction.runAsync("DELETE FROM revoked_households WHERE account_id = ? AND household_id = ?", accountId, household.id)
        const cached = await this.getCachedBoard(accountId, household.id, transaction)
        // Role changes also take effect locally, including when task edits are still pending.
        if (cached) await this.writeBoard(transaction, accountId, { ...cached.server, household })
        if (cached?.server.household.role !== household.role) {
          for (const run of await this.runCaches(accountId, household.id, transaction)) await this.writeRun(transaction, accountId, { ...run.server, household })
        }
      }
      for (const { household_id: householdId } of known) {
        if (allowed.has(householdId)) continue
        await transaction.runAsync("INSERT OR IGNORE INTO revoked_households(account_id, household_id) VALUES (?, ?)", accountId, householdId)
        await transaction.runAsync("DELETE FROM board_snapshots WHERE account_id = ? AND household_id = ?", accountId, householdId)
        await transaction.runAsync("DELETE FROM run_snapshots WHERE account_id = ? AND household_id = ?", accountId, householdId)
        await transaction.runAsync("DELETE FROM run_pages WHERE account_id = ? AND household_id = ?", accountId, householdId)
        await transaction.runAsync("DELETE FROM device_settings WHERE account_id = ? AND setting_key = ?", accountId, `board-display:${householdId}`)
        // Keep the user's unsent intent for explicit review; never keep sending it after revocation.
        await transaction.runAsync(`UPDATE pending_completions SET state = 'rejected', error = ?
          WHERE account_id = ? AND household_id = ?`, "Access to this household has been removed. This saved change cannot sync.", accountId, householdId)
      }
    })
  }

  async isHouseholdRevoked(accountId: string, householdId: string, connection: SqlConnection = this.database) {
    return Boolean(await connection.getFirstAsync("SELECT household_id FROM revoked_households WHERE account_id = ? AND household_id = ?", accountId, householdId))
  }

  async enqueueCompletion(input: Omit<CompletionChange, "sequence" | "correctedTimeMs" | "attempts" | "nextAttemptMs" | "state" | "error">) {
    let saved: CompletionChange | undefined
    await this.database.withExclusiveTransactionAsync(async transaction => {
      const cached = await this.getCachedBoard(input.accountId, input.householdId, transaction)
      const run = await this.runCache(input.accountId, input.householdId, input.occurrenceId, transaction)
      const snapshot = run?.board ?? cached?.board
      const task = snapshot?.tasks.find(item => item.id === input.taskId && item.occurrence_id === input.occurrenceId)
      if (!snapshot || !task) throw new Error("This task is not available on this device. Refresh the board first.")
      const kiosk = await kioskRestriction(transaction)
      if (kiosk && (input.accountId !== kiosk.accountId || input.deviceId !== kiosk.deviceId || input.householdId !== kiosk.householdId
        || !kiosk.editableMemberIds.includes(input.memberId) || !task.assignee_ids.includes(input.memberId))) throw new Error("This task cannot be changed on this kiosk.")
      if (run?.board.run.status === "cancelled") throw new Error("This run has been cancelled.")
      if (snapshot.household.role === "member" && !task.assignee_ids.includes(input.accountId)) throw new Error("You can only update tasks assigned to you.")
      if (input.completed && task.status === "locked") throw new Error("This task is not startable yet.")
      await transaction.runAsync(`INSERT INTO device_sequences(account_id, device_id, sequence) VALUES (?, ?, 1)
        ON CONFLICT(account_id, device_id) DO UPDATE SET sequence = sequence + 1`, input.accountId, input.deviceId)
      const counter = await transaction.getFirstAsync<{ sequence: number }>(
        "SELECT sequence FROM device_sequences WHERE account_id = ? AND device_id = ?", input.accountId, input.deviceId)
      if (!counter) throw new Error("Unable to save the task safely")
      saved = { ...input, sequence: counter.sequence, correctedTimeMs: null, attempts: 0, nextAttemptMs: 0, state: "pending", error: null }
      await transaction.runAsync(`INSERT INTO pending_completions
        (id, account_id, household_id, device_id, task_id, occurrence_id, member_id, completed, device_time_ms, sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id, input.accountId, input.householdId, input.deviceId, input.taskId, input.occurrenceId,
      input.memberId, input.completed ? 1 : 0, input.deviceTimeMs, saved.sequence)
      if (cached) await this.writeBoard(transaction, input.accountId, cached.server)
      if (run) await this.writeRun(transaction, input.accountId, run.server)
    })
    if (!saved) throw new Error("Unable to save the task safely")
    return saved
  }

  async correctBatch(accountId: string, ids: string[], offsetMs: number) {
    if (!Number.isSafeInteger(offsetMs)) throw new Error("Invalid clock correction")
    await this.database.withExclusiveTransactionAsync(async transaction => {
      for (const id of ids) {
        // Freeze the estimate before first transmission, including across lost acknowledgements.
        await transaction.runAsync(`UPDATE pending_completions SET corrected_time_ms = device_time_ms + ?
          WHERE account_id = ? AND id = ? AND corrected_time_ms IS NULL`, offsetMs, accountId, id)
      }
    })
  }

  async acknowledge(accountId: string, result: CompletionResult) {
    await this.database.withExclusiveTransactionAsync(async transaction => {
      const row = await transaction.getFirstAsync<PendingRow>(
        "SELECT * FROM pending_completions WHERE account_id = ? AND id = ?", accountId, result.operationId)
      if (!row) return
      if (result.outcome === "rejected") {
        await transaction.runAsync("UPDATE pending_completions SET state = 'rejected', error = ? WHERE account_id = ? AND id = ?",
          result.error ?? "The server could not accept this change.", accountId, result.operationId)
        return
      }
      await transaction.runAsync("DELETE FROM pending_completions WHERE account_id = ? AND id = ?", accountId, result.operationId)
      const cached = await this.getCachedBoard(accountId, row.household_id, transaction)
      if (cached) {
        await this.writeBoard(transaction, accountId, acknowledged(cached.server, row.occurrence_id, result))
      }
      const run = await this.runCache(accountId, row.household_id, row.occurrence_id, transaction)
      if (run) await this.writeRun(transaction, accountId, acknowledged(run.server, row.occurrence_id, result))
    })
  }

  async defer(accountId: string, id: string, message: string, now: number) {
    await this.database.withExclusiveTransactionAsync(async transaction => {
      const row = await transaction.getFirstAsync<PendingRow>(
        "SELECT * FROM pending_completions WHERE account_id = ? AND id = ?", accountId, id)
      if (!row) return
      await transaction.runAsync(`UPDATE pending_completions SET attempts = attempts + 1, next_attempt_ms = ?, error = ?
        WHERE account_id = ? AND id = ?`, now + retryDelayMs(row.attempts), message, accountId, id)
    })
  }

  async retryRejected(accountId: string, id: string) {
    await this.database.withExclusiveTransactionAsync(async transaction => {
      const change = await transaction.getFirstAsync<PendingRow>("SELECT * FROM pending_completions WHERE account_id = ? AND id = ?", accountId, id)
      if (!change) return
      if (await this.isHouseholdRevoked(accountId, change.household_id, transaction)) throw new Error("Access to this household has been removed.")
      await transaction.runAsync("UPDATE pending_completions SET state = 'pending', error = NULL, next_attempt_ms = 0 WHERE account_id = ? AND id = ?", accountId, id)
    })
  }

  async discardRejected(accountId: string, id: string, freshBoard: BoardSnapshot | null, freshRun?: RunSnapshot | null) {
    await this.database.withExclusiveTransactionAsync(async transaction => {
      const change = await transaction.getFirstAsync<PendingRow>("SELECT * FROM pending_completions WHERE account_id = ? AND id = ? AND state = 'rejected'", accountId, id)
      if (!change) return
      const revoked = await this.isHouseholdRevoked(accountId, change.household_id, transaction)
      if (!revoked && (!freshBoard || change.household_id !== freshBoard.household.id)) {
        throw new Error("Refresh the matching household before discarding this change.")
      }
      await transaction.runAsync("DELETE FROM pending_completions WHERE account_id = ? AND id = ? AND state = 'rejected'", accountId, id)
      if (revoked || !freshBoard) return
      const previous = await this.getCachedBoard(accountId, freshBoard.household.id, transaction)
      await this.writeBoard(transaction, accountId, mergeServerBoard(freshBoard, previous?.server))
      const run = await this.runCache(accountId, change.household_id, change.occurrence_id, transaction)
      if (freshRun && (freshRun.household.id !== change.household_id || freshRun.run.id !== change.occurrence_id)) throw new Error("Refresh the matching run before discarding this change.")
      if (freshRun) await this.writeRun(transaction, accountId, { ...freshRun, ...mergeServerBoard(freshRun, run?.server) })
      else if (freshRun === null) await this.removeRunInTransaction(transaction, accountId, change.household_id, change.occurrence_id)
      else if (run) await this.writeRun(transaction, accountId, run.server)
    })
  }

  async setting<T>(accountId: string, key: string): Promise<T | null> {
    const row = await this.database.getFirstAsync<{ data: string }>(
      "SELECT data FROM device_settings WHERE account_id = ? AND setting_key = ?", accountId, key)
    return row ? JSON.parse(row.data) as T : null
  }

  async boardDisplay(accountId: string, householdId: string) {
    return parseBoardDisplay(await this.setting(accountId, `board-display:${householdId}`))
  }

  async saveBoardDisplay(accountId: string, householdId: string, input: BoardDisplayPreferences) {
    const preferences = parseBoardDisplay(input)
    let saved = preferences
    await this.database.withExclusiveTransactionAsync(async tx => {
      await requireKioskParentAccess(tx)
      const cached = await this.getCachedBoard(accountId, householdId, tx)
      if (!cached || cached.server.household.role === "member" || await this.isHouseholdRevoked(accountId, householdId, tx)) throw new Error("Parent access to this household is required to change its display.")
      const valid = new Set(cached.server.members.map(member => member.id))
      const visible = preferences.visibleMemberIds?.filter(id => valid.has(id)) ?? null
      if (visible && !visible.length) throw new Error("Choose at least one household member to display.")
      const visibleSet = new Set(visible ?? valid)
      saved = { ...preferences, visibleMemberIds: visible,
        editableMemberIds: preferences.editableMemberIds?.filter(id => visibleSet.has(id)) ?? null }
      await tx.runAsync(`INSERT INTO device_settings(account_id, setting_key, data) VALUES (?, ?, ?)
        ON CONFLICT(account_id, setting_key) DO UPDATE SET data = excluded.data`, accountId, `board-display:${householdId}`, JSON.stringify(saved))
    })
    return saved
  }

  async saveSetting(accountId: string, key: string, value: unknown) {
    await this.database.withExclusiveTransactionAsync(async tx => {
      const kiosk = await kioskRestriction(tx)
      if (kiosk && (accountId !== kiosk.accountId || key !== "selected-household" || value !== kiosk.householdId)) throw new Error("Unlock kiosk mode to change device settings.")
      await tx.runAsync(`INSERT INTO device_settings(account_id, setting_key, data) VALUES (?, ?, ?)
        ON CONFLICT(account_id, setting_key) DO UPDATE SET data = excluded.data`, accountId, key, JSON.stringify(value))
    })
  }
}
