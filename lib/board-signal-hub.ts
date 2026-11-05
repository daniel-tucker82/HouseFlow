import type { Notification, Pool, PoolClient } from "pg"
import { randomUUID } from "node:crypto"

interface Subscriber { changed(): void; disconnected(): void; close(): void }

/** One LISTEN connection per active server instance, shared across households.
 * The caller must authorize the household before passing its database channel.
 * A registration resolves only after LISTEN commits; fetch the snapshot then.
 * These empty hints are not a durable message queue or an authorization grant. */
export class BoardSignalHub {
  private client: PoolClient | null = null
  private groups = new Map<string, Set<Subscriber>>()
  private queue: Promise<void> = Promise.resolve()
  private count = 0

  constructor(private pool: { connect(): Promise<PoolClient> }, private sender: Pick<Pool, "query">, private limit = 256) {}

  private ordered<T>(action: () => Promise<T>) {
    const result = this.queue.then(action)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  private disconnect(client: PoolClient) {
    if (this.client !== client) return
    this.client = null
    const old = [...this.groups.values()].flatMap(subscribers => [...subscribers])
    this.groups.clear()
    client.release(true)
    for (const subscriber of old) {
      subscriber.close()
      try { subscriber.disconnected() } catch { /* A failed consumer cannot strand others. */ }
    }
  }

  private async connection() {
    if (this.client) return this.client
    const client = await this.pool.connect()
    this.client = client
    client.on("error", () => this.disconnect(client))
    client.once("end", () => this.disconnect(client))
    client.on("notification", (event: Notification) => {
      if (this.client !== client || event.payload) return
      for (const subscriber of [...(this.groups.get(event.channel) ?? [])]) {
        try { subscriber.changed() } catch { subscriber.close() }
      }
    })
    // Prove the listener receives commits from the application's actual
    // database. An accidentally configured listener on a different branch can
    // execute LISTEN successfully but would silently miss every family edit.
    const probe = "cyntch_probe_" + randomUUID().replaceAll("-", "")
    let accept!: () => void
    const received = new Promise<void>(resolve => { accept = resolve })
    const observe = (event: Notification) => { if (event.channel === probe && !event.payload) accept() }
    client.on("notification", observe)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await client.query("LISTEN " + probe)
      await Promise.race([
        Promise.all([this.sender.query("select pg_notify($1,'')", [probe]), received]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Board listener probe timed out.")), 3_000) }),
      ])
      if (this.client !== client) throw new Error("Board listener disconnected.")
      await client.query("UNLISTEN " + probe)
    } catch (error) { this.disconnect(client); throw error }
    finally { clearTimeout(timer); client.removeListener("notification", observe) }
    return client
  }

  async subscribe(channel: string, signal: AbortSignal, callbacks: Pick<Subscriber, "changed" | "disconnected">) {
    if (!/^cyntch_board_[0-9a-f]{32}$/.test(channel)) throw new Error("Invalid board channel.")
    if (signal.aborted) throw new Error("Board subscription cancelled.")
    if (this.count >= this.limit) throw new Error("Board subscription capacity reached.")
    this.count++
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      signal.removeEventListener("abort", close)
      // Stop synchronous dispatch immediately, even while an unrelated LISTEN
      // is being installed. Only the database operations need serialization.
      this.groups.get(channel)?.delete(subscriber)
      void this.ordered(async () => {
        // Count a cancelled registration until its queued setup has drained.
        // Repeated connect/abort cannot create an unbounded queue of work.
        this.count--
        const client = this.client, group = this.groups.get(channel)
        if (!client) return
        if (this.count === 0) { this.disconnect(client); return }
        if (group?.size === 0) {
          this.groups.delete(channel)
          try { await client.query("UNLISTEN " + channel) } catch { this.disconnect(client) }
        }
      })
    }
    const subscriber = { ...callbacks, close }
    signal.addEventListener("abort", close, { once: true })
    try {
      await this.ordered(async () => {
        if (closed) throw new Error("Board subscription cancelled.")
        const client = await this.connection()
        if (closed) throw new Error("Board subscription cancelled.")
        let group = this.groups.get(channel)
        if (!group) {
          try { await client.query("LISTEN " + channel) }
          catch (error) { this.disconnect(client); throw error }
          if (this.client !== client) throw new Error("Board subscription interrupted.")
          group = new Set()
          this.groups.set(channel, group)
        }
        if (closed) throw new Error("Board subscription cancelled.")
        group.add(subscriber)
      })
      if (closed) throw new Error("Board subscription interrupted.")
      return close
    } catch (error) { close(); throw error }
  }
}
