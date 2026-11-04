import type { Pool, PoolClient } from "pg"

export class SchedulerDeadlineExceeded extends Error {
  constructor() { super("Scheduler processing deadline exceeded") }
}

/** A monotonic request budget, independent of wall-clock corrections. */
export class SchedulerDeadline {
  private readonly expiresAt: number
  constructor(milliseconds: number) { this.expiresAt = performance.now() + milliseconds }
  remaining() { return Math.max(0, Math.floor(this.expiresAt - performance.now())) }
  assertActive() { if (this.remaining() < 1) throw new SchedulerDeadlineExceeded() }

  async run<T>(operation: () => Promise<T>, onTimeout: () => void = () => {}): Promise<T> {
    this.assertActive()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            try { onTimeout() } finally { reject(new SchedulerDeadlineExceeded()) }
          }, this.remaining())
        }),
      ])
    } finally { clearTimeout(timer) }
  }
}

/**
 * Own the connection until COMMIT, or discard it on failure/deadline. A JS
 * timeout alone cannot cancel PostgreSQL: closing this connection rolls back
 * its transaction. Server timeouts also bound SQL/idle transactions if the
 * process disappears. A callback resumed after cancellation cannot issue SQL.
 * Uses PostgreSQL 14+ settings, without requiring PG17 transaction_timeout.
 */
export async function schedulerTransaction<T>(
  pool: Pool, deadline: SchedulerDeadline, operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let connection: PoolClient | undefined
  let active = true
  let committed = false
  const connectionError = () => { active = false }
  const release = (destroy: boolean) => {
    if (!connection) return
    const client = connection
    connection = undefined
    client.release(destroy)
    client.removeListener("error", connectionError)
  }
  try {
    return await deadline.run(async () => {
      const client = await pool.connect()
      // Pool acquisition can resolve after the caller's deadline. Never leak
      // that late checkout, or let it start an abandoned transaction.
      if (!active) { client.release(true); throw new SchedulerDeadlineExceeded() }
      connection = client
      client.on("error", connectionError)
      await client.query("BEGIN")
      let statementMs = Math.min(5_000, deadline.remaining())
      deadline.assertActive()
      await client.query(`select set_config('statement_timeout',$1,true),
        set_config('idle_in_transaction_session_timeout',$1,true),
        set_config('lock_timeout','2000ms',true)`, [`${statementMs}ms`])
      const guarded = new Proxy(client, {
        get(target, property) {
          if (property === "query") return async (text: string, values?: unknown[]) => {
            if (!active) throw new SchedulerDeadlineExceeded()
            deadline.assertActive()
            const remaining = deadline.remaining()
            if (remaining < statementMs) {
              statementMs = remaining
              await target.query(`select set_config('statement_timeout',$1,true),
                set_config('idle_in_transaction_session_timeout',$1,true)`, [`${statementMs}ms`])
            }
            if (!active) throw new SchedulerDeadlineExceeded()
            deadline.assertActive()
            return target.query(text, values)
          }
          const value = Reflect.get(target, property)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
      const result = await operation(guarded)
      await guarded.query("COMMIT")
      committed = true
      return result
    }, () => { active = false; release(true) })
  } finally {
    active = false
    release(!committed)
  }
}
