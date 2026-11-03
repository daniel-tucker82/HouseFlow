import { parseNativeNotificationPayload, type NativeNotificationPayload } from "../../../shared/mobile/notification-payload"
import type { LocalDatabase } from "./local-store"
import type { NotificationSession } from "./notification-session-store"

/** Latest explicit tap wins; delivery IDs make OS redelivery/restart idempotent. */
export class NotificationInbox {
  constructor(private readonly db: LocalDatabase) {}
  initialize() { return this.db.execAsync(`CREATE TABLE IF NOT EXISTS notification_taps (
    session_id TEXT NOT NULL,delivery_id TEXT NOT NULL,account_id TEXT NOT NULL,data TEXT NOT NULL,
    received_ms INTEGER NOT NULL,handled INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,delivery_id));`) }
  async capture(input: unknown, session: NotificationSession, now = Date.now()) {
    const payload = parseNativeNotificationPayload(input)
    if (!payload || payload.accountId !== session.accountId || payload.sessionId !== session.sessionId) return false
    let captured = false
    await this.db.withExclusiveTransactionAsync(async tx => {
      if (!await tx.getFirstAsync("SELECT 1 FROM notification_sessions WHERE account_id=? AND session_id=? AND revoked=0", session.accountId, session.sessionId)) return
      const existing = await tx.getFirstAsync("SELECT 1 FROM notification_taps WHERE session_id=? AND delivery_id=?", session.sessionId, payload.deliveryId)
      if (!existing) {
        await tx.runAsync("UPDATE notification_taps SET handled=1 WHERE session_id=?", session.sessionId)
        await tx.runAsync("INSERT INTO notification_taps(session_id,delivery_id,account_id,data,received_ms) VALUES(?,?,?,?,?)", session.sessionId, payload.deliveryId, session.accountId, JSON.stringify(payload), now)
        await tx.runAsync(`DELETE FROM notification_taps WHERE session_id=? AND handled=1 AND delivery_id NOT IN
          (SELECT delivery_id FROM notification_taps WHERE session_id=? ORDER BY received_ms DESC,delivery_id LIMIT 200)`, session.sessionId, session.sessionId)
      }
      captured = true
    })
    return captured
  }
  async pending(session: NotificationSession): Promise<NativeNotificationPayload | null> {
    const row = await this.db.getFirstAsync<{ data: string }>(`SELECT t.data FROM notification_taps t JOIN notification_sessions s ON s.session_id=t.session_id
      WHERE t.session_id=? AND t.account_id=? AND t.handled=0 AND s.revoked=0 AND s.account_id=t.account_id`, session.sessionId, session.accountId)
    return row ? parseNativeNotificationPayload(JSON.parse(row.data)) : null
  }
  acknowledge(payload: NativeNotificationPayload) {
    return this.db.runAsync("UPDATE notification_taps SET handled=1 WHERE session_id=? AND account_id=? AND delivery_id=?", payload.sessionId, payload.accountId, payload.deliveryId)
  }
}
