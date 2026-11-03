import type { NotificationSession, NotificationSessionStore } from "../storage/notification-session-store"

/** Runs while signed out too. Retries depend on connectivity/lifecycle, not a login token. */
export class NotificationSessionController {
  private online = false
  private active = true
  private stopped = false
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly store: NotificationSessionStore, private readonly revoke: (session: NotificationSession) => Promise<void>, private readonly now = Date.now) {}
  setConnectivity(online: boolean) { this.online = online; this.wake() }
  setActive(active: boolean) { this.active = active; this.wake() }
  wake() {
    clearTimeout(this.timer)
    if (!this.online || !this.active || this.stopped || this.running) return
    this.running = this.flush().catch(() => {}).finally(async () => {
      this.running = null
      if (!this.online || !this.active || this.stopped) return
      try {
        const pending = await this.store.pending()
        if (pending.length && !this.stopped && this.online && this.active) this.timer = setTimeout(() => this.wake(), Math.max(50, pending[0].nextAttemptMs - this.now()))
      } catch { /* A later lifecycle/connectivity event retries a storage failure. */ }
    })
  }
  private async flush() {
    for (const session of await this.store.pending()) {
      if (!this.online || !this.active || this.stopped) return
      if (session.nextAttemptMs > this.now()) continue
      try { await this.revoke(session); await this.store.acknowledge(session) }
      catch { await this.store.fail(session, this.now()) }
    }
  }
  stop() { this.stopped = true; clearTimeout(this.timer) }
}

export function notificationRevocationTransport(baseUrl: string, deviceId: string, installationSecret: () => Promise<string>, request: typeof fetch = fetch) {
  const endpoint = new URL("/api/mobile/notifications/revoke", baseUrl)
  if (endpoint.protocol !== "https:" && !(typeof __DEV__ !== "undefined" && __DEV__)) throw new Error("Cyntch requires a secure connection")
  return async (session: NotificationSession) => {
    const secret = await installationSecret()
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await request(endpoint.toString(), {
        method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", "X-Cyntch-Device": deviceId, "X-Cyntch-Installation": secret }, body: JSON.stringify(session),
      })
      const data = await response.json()
      if (!response.ok || data?.revoked !== true || data.deviceId !== deviceId || data.accountId !== session.accountId || data.sessionId !== session.sessionId) throw new Error("Notification sign-out is waiting to sync.")
    } finally { clearTimeout(timeout) }
  }
}
