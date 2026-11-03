import type { BoardSnapshot, CompletionChange, CompletionResult } from "../../../shared/mobile/contracts"
import { retryDelayMs } from "../../../shared/mobile/sync-policy"

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

/** The device database is the durable outbox. Network callbacks never own it. */
export class LocalStore {
  constructor(private readonly database: LocalDatabase) {}

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
      PRAGMA user_version = 1;
    `)
  }

  async getBoard(accountId: string, householdId: string, connection: SqlConnection = this.database) {
    const row = await connection.getFirstAsync<{ data: string }>(
      "SELECT data FROM board_snapshots WHERE account_id = ? AND household_id = ?", accountId, householdId)
    return row ? JSON.parse(row.data) as BoardSnapshot : null
  }

  async getBoards(accountId: string) {
    const rows = await this.database.getAllAsync<{ data: string }>("SELECT data FROM board_snapshots WHERE account_id = ?", accountId)
    return rows.map(row => JSON.parse(row.data) as BoardSnapshot)
  }

  async pending(accountId: string, connection: SqlConnection = this.database) {
    return (await connection.getAllAsync<PendingRow>(
      "SELECT * FROM pending_completions WHERE account_id = ? ORDER BY sequence", accountId)).map(fromRow)
  }

  private async writeBoard(connection: SqlConnection, accountId: string, snapshot: BoardSnapshot) {
    await connection.runAsync(`INSERT INTO board_snapshots(account_id, household_id, data) VALUES (?, ?, ?)
      ON CONFLICT(account_id, household_id) DO UPDATE SET data = excluded.data`,
    accountId, snapshot.household.id, JSON.stringify(snapshot))
  }

  async cacheBoard(accountId: string, snapshot: BoardSnapshot) {
    let merged = snapshot
    await this.database.withExclusiveTransactionAsync(async transaction => {
      const pending = (await this.pending(accountId, transaction)).filter(change => change.householdId === snapshot.household.id)
      // A refresh cannot erase an edit created while the request was in flight.
      merged = overlayChanges(snapshot, pending)
      await this.writeBoard(transaction, accountId, merged)
    })
    return merged
  }

  async enqueueCompletion(input: Omit<CompletionChange, "sequence" | "correctedTimeMs" | "attempts" | "nextAttemptMs" | "state" | "error">) {
    let saved: CompletionChange | undefined
    await this.database.withExclusiveTransactionAsync(async transaction => {
      const snapshot = await this.getBoard(input.accountId, input.householdId, transaction)
      const task = snapshot?.tasks.find(item => item.id === input.taskId && item.occurrence_id === input.occurrenceId)
      if (!snapshot || !task) throw new Error("This task is not available on this device. Refresh the board first.")
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
      await this.writeBoard(transaction, input.accountId, overlayChanges(snapshot, [saved]))
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
      const snapshot = await this.getBoard(accountId, row.household_id, transaction)
      if (snapshot) {
        const statuses = new Map(result.occurrenceTaskStatuses.map(item => [item.task_id, item.status]))
        const updated: BoardSnapshot = { ...snapshot, tasks: snapshot.tasks.map(task =>
          task.occurrence_id === row.occurrence_id && statuses.has(task.id) ? { ...task, status: statuses.get(task.id)! } : task) }
        const outstanding = (await this.pending(accountId, transaction)).filter(change => change.householdId === row.household_id)
        await this.writeBoard(transaction, accountId, overlayChanges(updated, outstanding))
      }
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
    await this.database.runAsync("UPDATE pending_completions SET state = 'pending', error = NULL, next_attempt_ms = 0 WHERE account_id = ? AND id = ?", accountId, id)
  }

  async discardRejected(accountId: string, id: string, freshBoard: BoardSnapshot) {
    await this.database.withExclusiveTransactionAsync(async transaction => {
      await transaction.runAsync("DELETE FROM pending_completions WHERE account_id = ? AND id = ? AND state = 'rejected'", accountId, id)
      const pending = (await this.pending(accountId, transaction)).filter(change => change.householdId === freshBoard.household.id)
      await this.writeBoard(transaction, accountId, overlayChanges(freshBoard, pending))
    })
  }

  async setting<T>(accountId: string, key: string): Promise<T | null> {
    const row = await this.database.getFirstAsync<{ data: string }>(
      "SELECT data FROM device_settings WHERE account_id = ? AND setting_key = ?", accountId, key)
    return row ? JSON.parse(row.data) as T : null
  }

  async saveSetting(accountId: string, key: string, value: unknown) {
    await this.database.runAsync(`INSERT INTO device_settings(account_id, setting_key, data) VALUES (?, ?, ?)
      ON CONFLICT(account_id, setting_key) DO UPDATE SET data = excluded.data`, accountId, key, JSON.stringify(value))
  }
}
