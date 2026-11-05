export type BoardWatch = (household: string, signal: AbortSignal, hint: () => void) => Promise<void>

/** Parse only the two data-free frames. Authorization and actual task data
 * always come from the normal board fetch. Native network chunks need not
 * coincide with lines. A truncated/unknown protocol reconnects with backoff. */
export async function readBoardHints(body: ReadableStream<Uint8Array>, signal: AbortSignal, hint: () => void) {
  const reader = body.getReader()
  let line = "", ready = false
  try {
    while (!signal.aborted) {
      const chunk = await reader.read()
      if (chunk.done) break
      for (const byte of chunk.value) {
        if (signal.aborted) return
        if (byte !== 10) {
          if (byte < 97 || byte > 122 || line.length >= 7) throw new Error("Invalid board signal.")
          line += String.fromCharCode(byte)
        } else {
          if (line !== (ready ? "changed" : "ready")) throw new Error("Unexpected board signal.")
          ready = true; line = ""; hint()
        }
      }
    }
    if (!signal.aborted && (!ready || line)) throw new Error("Incomplete board signal.")
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

/** Exists only for an active, connected, authorized board. Coalesce bursts
 * during a slow refresh, and reconnect after service restarts without a busy
 * loop. Opening a new connection always fetches after its LISTEN handshake. */
export class ForegroundBoardWatch {
  private scope: { id: string; stop: AbortController } | null = null
  constructor(private open: BoardWatch, private refresh: () => Promise<void>) {}
  select(id: string | null) {
    if (id === (this.scope?.id ?? null)) return
    this.scope?.stop.abort()
    const scope = id ? { id, stop: new AbortController() } : null
    this.scope = scope
    if (!scope) return
    const signal = scope.stop.signal
    let retry: ReturnType<typeof setTimeout> | undefined, batch: ReturnType<typeof setTimeout> | undefined
    let busy = false, dirty = false, failures = 0, accessChecked = false
    const schedule = () => {
      dirty = true
      if (busy || batch || signal.aborted) return
      batch = setTimeout(() => {
        batch = undefined
        if (signal.aborted) return
        dirty = false; busy = true
        void this.refresh().catch(() => {}).finally(() => {
          busy = false
          if (dirty && !signal.aborted) schedule()
        })
      }, 150)
    }
    const connect = async () => {
      if (signal.aborted) return
      let armed = false
      const start = Date.now()
      const attempt = new AbortController(), cancel = () => attempt.abort()
      signal.addEventListener("abort", cancel, { once: true })
      const deadline = setTimeout(cancel, 55_000)
      try { await this.open(scope.id, attempt.signal, () => { if (!attempt.signal.aborted) { armed = true; accessChecked = false; schedule() } }) }
      catch (error) {
        const status = (error as { status?: number } | null)?.status
        // Recheck stale membership/kiosk access once through the canonical API.
        if (!accessChecked && [401, 403, 410, 423].includes(status ?? 0)) { accessChecked = true; schedule() }
      } finally { clearTimeout(deadline); signal.removeEventListener("abort", cancel) }
      if (signal.aborted) return
      failures = armed && Date.now() - start >= 5_000 ? 0 : Math.min(failures + 1, 7)
      const delay = Math.min(30_000, 250 * 2 ** failures)
      retry = setTimeout(() => { void connect() }, delay + Math.floor(Math.random() * delay / 4))
    }
    signal.addEventListener("abort", () => { clearTimeout(batch); clearTimeout(retry) }, { once: true })
    void connect()
  }
}
