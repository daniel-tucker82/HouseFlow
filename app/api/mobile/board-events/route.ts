import { auth } from "@clerk/nextjs/server"
import { AccountAccessError } from "@/lib/account-access"
import { BoardSignalHub } from "@/lib/board-signal-hub"
import { boardListenDb, boardListenerUrl } from "@/lib/board-listen-db"
import { db, kioskGateDb } from "@/lib/db"
import { EntitlementError } from "@/lib/entitlements"
import { guardNativeKioskRequest } from "@/lib/native-kiosk-guard"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { KioskError } from "@/shared/mobile/kiosk"
import { notificationUuid } from "@/shared/mobile/notification-settings"

export const dynamic = "force-dynamic"
export const maxDuration = 60
const hub = new BoardSignalHub(boardListenDb, db)
const privateHeaders = { "Cache-Control": "private, no-store, no-transform" }
const empty = (status: number) => new Response(null, { status, headers: privateHeaders })
const frames = { ready: new TextEncoder().encode("ready\n"), changed: new TextEncoder().encode("changed\n") }

export async function GET(request: Request) {
  if (!boardListenerUrl()) return empty(404)
  const { userId, sessionId, sessionClaims } = await auth()
  if (!userId || !sessionId || typeof sessionClaims?.exp !== "number") return empty(401)
  const device = request.headers.get("X-Cyntch-Device") ?? ""
  if (!notificationUuid.test(device) || request.headers.get("X-Task-Save-User") !== userId ||
      request.headers.get("X-Cyntch-Session") !== sessionId) return empty(403)
  const household = new URL(request.url).searchParams.get("householdId") ?? ""
  if (!notificationUuid.test(household)) return empty(400)
  const leaseEnds = Math.min(Date.now() + 45_000, sessionClaims.exp * 1_000)
  if (leaseEnds <= Date.now()) return empty(401)
  let channel = ""
  // Never hold a kiosk/admission lock or a query connection while a screen is
  // idle. Recheck before signalling: membership, deletion and kiosk changes can
  // revoke a screen while its underlying socket remains open.
  const authorize = () => guardNativeKioskRequest(kioskGateDb, request, userId, sessionId, async () => {
    if (Date.now() >= leaseEnds) return empty(401)
    if (channel) {
      const allowed = await db.query("select 1 from household_members where household_id=$1 and user_id=$2", [household, userId])
      return empty(allowed.rowCount ? 204 : 403)
    }
    const result = await db.query<{ channel: string; installed: boolean }>(
      `select 'cyntch_board_'||md5(n.nspname||':'||hm.household_id::text) as channel,
        exists(select 1 from pg_trigger where tgrelid=c.oid and tgname='board_occurrence_status_changed' and tgenabled in ('O','A')) as installed
       from household_members hm join pg_class c on c.oid='occurrence_tasks'::regclass
       join pg_namespace n on n.oid=c.relnamespace where hm.household_id=$1 and hm.user_id=$2`, [household, userId])
    if (!result.rows[0]) return empty(403)
    // A flag switched on before its migration must not return a false "ready".
    if (!result.rows[0].installed) return empty(503)
    channel = result.rows[0].channel
    return empty(204)
  })

  const stop = new AbortController()
  let output: ReadableStreamDefaultController<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, dirty = false, checking = false
  const end = () => {
    if (stop.signal.aborted) return
    stop.abort(); clearTimeout(timer); request.signal.removeEventListener("abort", end)
    try { output?.close() } catch { /* The consumer may already have cancelled. */ }
  }
  async function sendChange() {
    dirty = true
    if (!output || checking || stop.signal.aborted) return
    checking = true
    try {
      while (dirty && !stop.signal.aborted) {
        dirty = false
        const admission = await authorize()
        if (!admission.ok || Date.now() >= leaseEnds) { end(); return }
        if (!stop.signal.aborted) {
          // Reconnecting clients reload after LISTEN is armed. An unresponsive
          // reader must not accumulate a growing queue of obsolete hints.
          if ((output.desiredSize ?? 0) <= 0) { end(); return }
          output.enqueue(frames.changed)
        }
      }
    } catch { end() } finally { checking = false }
  }
  try {
    await enforceRequestLimit(userId, "read")
    const admission = await authorize()
    if (!admission.ok) return admission
    request.signal.addEventListener("abort", end, { once: true })
    if (request.signal.aborted || Date.now() >= leaseEnds) { end(); return empty(408) }
    timer = setTimeout(end, leaseEnds - Date.now())
    await hub.subscribe(channel, stop.signal, { changed: () => { void sendChange() }, disconnected: end })
    if (stop.signal.aborted) return empty(503)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; output.enqueue(frames.ready); if (dirty) void sendChange() },
      cancel: end,
    })
    return new Response(stream, { headers: { ...privateHeaders, "Content-Type": "text/plain; charset=utf-8", "X-Accel-Buffering": "no" } })
  } catch (error) {
    const cancelled = stop.signal.aborted || request.signal.aborted
    end()
    if (cancelled) return empty(408)
    if (error instanceof AccountAccessError || error instanceof EntitlementError || error instanceof KioskError) return empty(error.status)
    console.error("[board-events] Subscription unavailable", { name: error instanceof Error ? error.name : "UnknownError" })
    return empty(503)
  }
}
