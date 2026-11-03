import type { LocalDatabase, SqlConnection } from "./local-store"
import { retryDelayMs } from "../../../shared/mobile/sync-policy"
import { kioskRestriction } from "./kiosk-store"

export interface NotificationSession { accountId: string; sessionId: string }
export interface PendingNotificationRevocation extends NotificationSession { attempts: number; nextAttemptMs: number }
interface SessionRow { account_id: string; session_id: string; revoked: number; pending: number; attempts: number; next_attempt_ms: number }

/** Sign-out fences are separate from the signed-in account's task outbox. */
export class NotificationSessionStore {
  constructor(private readonly db: LocalDatabase) {}
  initialize() {
    return this.db.execAsync(`CREATE TABLE IF NOT EXISTS notification_sessions (
      session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      pending INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_notification_session ON notification_sessions(revoked) WHERE revoked=0;
      CREATE TABLE IF NOT EXISTS notification_native_cleanup (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, completed INTEGER NOT NULL);
      INSERT OR IGNORE INTO notification_native_cleanup VALUES(1,0,0);`)
  }
  private requireCleanup(tx: SqlConnection) { return tx.runAsync("UPDATE notification_native_cleanup SET generation=generation+1 WHERE id=1") }
  async kioskRestricted() { return Boolean(await kioskRestriction(this.db)) }
  async active(): Promise<NotificationSession | null> {
    const row = await this.db.getFirstAsync<SessionRow>("SELECT account_id,session_id FROM notification_sessions WHERE revoked=0")
    return row ? { accountId: row.account_id, sessionId: row.session_id } : null
  }
  async cleanupVersion() {
    const row = await this.db.getFirstAsync<{ generation: number }>("SELECT generation FROM notification_native_cleanup WHERE generation>completed")
    return row?.generation ?? null
  }
  completeCleanup(version: number) { return this.db.runAsync("UPDATE notification_native_cleanup SET completed=MAX(completed,?) WHERE id=1", version) }
  async activate(session: NotificationSession | null) {
    let changed = false, allowed = true
    await this.db.withExclusiveTransactionAsync(async tx => {
      const current = await tx.getFirstAsync<SessionRow>("SELECT * FROM notification_sessions WHERE revoked=0")
      if (session && current?.account_id === session.accountId && current.session_id === session.sessionId) return
      if (session) {
        const prior = await tx.getFirstAsync<SessionRow>("SELECT * FROM notification_sessions WHERE session_id=?", session.sessionId)
        if (prior?.revoked || (prior && prior.account_id !== session.accountId)) { allowed = false; return }
      }
      if (current) {
        await tx.runAsync("UPDATE notification_sessions SET revoked=1,pending=1,next_attempt_ms=0 WHERE session_id=?", current.session_id)
        await tx.runAsync("DELETE FROM native_notification_settings WHERE account_id=? AND scope='device'", current.account_id)
        await tx.runAsync("DELETE FROM notification_taps WHERE session_id=?", current.session_id)
        changed = true
      }
      // Persist the OS cleanup too: an interruption after committing sign-out must
      // not leave the old native token registered on the next launch.
      await this.requireCleanup(tx)
      if (!session) return
      // A new Clerk session must never replay the old session's frozen registration.
      await tx.runAsync("DELETE FROM native_notification_settings WHERE account_id=? AND scope='device'", session.accountId)
      await tx.runAsync("INSERT INTO notification_sessions(session_id,account_id) VALUES(?,?)", session.sessionId, session.accountId)
      changed = true
    })
    return { changed, allowed }
  }
  async close(session: NotificationSession) {
    await this.db.withExclusiveTransactionAsync(async tx => {
      const active = await tx.getFirstAsync<SessionRow>("SELECT * FROM notification_sessions WHERE account_id=? AND session_id=? AND revoked=0", session.accountId, session.sessionId)
      await tx.runAsync(`INSERT INTO notification_sessions(session_id,account_id,revoked,pending) VALUES(?,?,1,1)
        ON CONFLICT(session_id) DO UPDATE SET revoked=1,pending=1,next_attempt_ms=0 WHERE account_id=excluded.account_id`, session.sessionId, session.accountId)
      if (active) {
        await tx.runAsync("DELETE FROM native_notification_settings WHERE account_id=? AND scope='device'", session.accountId)
        await tx.runAsync("DELETE FROM notification_taps WHERE session_id=?", session.sessionId)
        await this.requireCleanup(tx)
      }
    })
  }
  async pending(): Promise<PendingNotificationRevocation[]> {
    return (await this.db.getAllAsync<SessionRow>("SELECT * FROM notification_sessions WHERE pending=1 ORDER BY next_attempt_ms,session_id"))
      .map(row => ({ accountId: row.account_id, sessionId: row.session_id, attempts: row.attempts, nextAttemptMs: row.next_attempt_ms }))
  }
  async acknowledge(session: NotificationSession) {
    await this.db.runAsync("UPDATE notification_sessions SET pending=0 WHERE account_id=? AND session_id=? AND revoked=1", session.accountId, session.sessionId)
  }
  async fail(session: PendingNotificationRevocation, now: number) {
    await this.db.runAsync("UPDATE notification_sessions SET attempts=attempts+1,next_attempt_ms=? WHERE account_id=? AND session_id=? AND pending=1",
      now + retryDelayMs(session.attempts), session.accountId, session.sessionId)
  }
}
