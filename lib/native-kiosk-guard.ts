import { auth } from "@clerk/nextjs/server"
import type { Pool, PoolClient } from "pg"
import { kioskGateDb } from "@/lib/db"
import { kioskSessionKey, kioskSnapshot, readKioskForSession, type KioskRow } from "@/lib/native-kiosk-store"
import { normalizeRole } from "@/lib/household-authz"
import { KioskError, restrictKioskBoard } from "@/shared/mobile/kiosk"
import { notificationUuid } from "@/shared/mobile/notification-settings"
import type { BoardSnapshot, CompletionResult } from "@/shared/mobile/contracts"
import { accountAccessKey, AccountAccessError, assertAccountActive } from "@/lib/account-access"

async function restrictRequest(client: PoolClient, request: Request, row: KioskRow) {
  if (row.state === "recovered") throw new KioskError("This sign-in session has ended. Sign in again.", 401)
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname === "/api/mobile/time") return request
  const membership = (await client.query<{ role: string }>("select role from household_members where household_id=$1 and user_id=$2", [row.household_id, row.user_id])).rows[0]
  if (!membership || normalizeRole(membership.role) !== "manager") throw new KioskError("Parent access to this household changed. Kiosk mode remains locked.", 423, "kiosk_access_changed")
  if (request.method === "GET" && url.pathname === "/api/mobile/bootstrap") {
    const requested = url.searchParams.get("householdId")
    if (requested && requested !== row.household_id) throw new KioskError("Unlock kiosk mode to switch households.", 423)
    url.searchParams.set("householdId", row.household_id)
    return new Request(url, request)
  }
  if (request.method !== "POST" || !["/api/mobile/completions", "/api/leader/flow"].includes(url.pathname)) throw new KioskError("Unlock kiosk mode to use parent controls.", 423)
  const raw = await request.clone().text()
  if (Buffer.byteLength(raw, "utf8") > 8192) throw new KioskError("This kiosk task change is too large.")
  let body: Record<string, unknown>
  try { body = JSON.parse(raw) } catch { throw new KioskError("Choose a valid task change.") }
  if (!body || body.action !== "setOccurrenceTaskCompleted" || body.householdId !== row.household_id) throw new KioskError("Kiosk mode allows only permitted task updates.", 423)
  const memberId = body.actorMemberId, taskId = body.taskId, occurrenceId = body.occurrenceId
  if (typeof memberId !== "string" || !row.editable_member_ids.includes(memberId) || !row.visible_member_ids.includes(memberId)) throw new KioskError("This member's tasks cannot be changed on this kiosk.", 403)
  if (typeof taskId !== "string" || !notificationUuid.test(taskId) || typeof occurrenceId !== "string" || !notificationUuid.test(occurrenceId)) throw new KioskError("Choose a valid task.")
  if (!body.clientOperation || typeof body.clientOperation !== "object" || (body.clientOperation as Record<string, unknown>).deviceId !== row.device_id) throw new KioskError("This task change belongs to a different device.", 403)
  const task = (await client.query(`select 1 from occurrence_tasks ot join routine_occurrences ro on ro.id=ot.occurrence_id
    join task_assignees ta on ta.task_id=ot.task_id join household_members hm on hm.household_id=ro.household_id and hm.user_id=ta.user_id
    where ot.occurrence_id=$1 and ot.task_id=$2 and ro.household_id=$3 and ta.user_id=$4`, [occurrenceId, taskId, row.household_id, memberId])).rows[0]
  if (!task) throw new KioskError("This task is no longer available to the selected member.", 403)
  return request
}
async function restrictResponse(client: PoolClient, request: Request, response: Response, row: KioskRow) {
  if (!response.ok || new URL(request.url).pathname === "/api/mobile/time") return response
  let body = await response.json()
  if (request.method === "GET") {
    const board = body.board ? restrictKioskBoard(body.board as BoardSnapshot, kioskSnapshot(row)) : null
    body = { accountId: row.user_id, households: board ? [board.household] : [], board, kiosk: kioskSnapshot(row) }
  } else {
    const payload = await request.clone().json()
    const tasks = (await client.query<{ task_id: string }>(`select distinct ot.task_id from occurrence_tasks ot
      join routine_occurrences ro on ro.id=ot.occurrence_id join task_assignees ta on ta.task_id=ot.task_id
      join household_members hm on hm.household_id=ro.household_id and hm.user_id=ta.user_id
      where ot.occurrence_id=$1 and ro.household_id=$2 and ta.user_id=any($3::text[])`, [payload.occurrenceId, row.household_id, row.visible_member_ids])).rows
    const visible = new Set(tasks.map(task => task.task_id))
    body = { ...body, occurrenceTaskStatuses: (body.occurrenceTaskStatuses as CompletionResult["occurrenceTaskStatuses"] ?? []).filter(status => visible.has(status.task_id)) }
  }
  const headers = new Headers(response.headers); headers.set("Cache-Control", "no-store"); headers.delete("Content-Length")
  return Response.json(body, { status: response.status, headers })
}

/** Recheck assignment and role under the flow route's household write lock. */
export async function recheckNativeKioskFlow(client: PoolClient, accountId: string, sessionId: string | null | undefined, request: Request) {
  if (!sessionId) return
  const row = await readKioskForSession(client, accountId, sessionId)
  if (row && row.state !== "unlocked") await restrictRequest(client, request, row)
}

/** No client flag can turn off a lock bound to the authenticated Clerk session. */
export async function guardNativeKioskRequest(pool: Pool, request: Request, accountId: string, sessionId: string,
  work: (request: Request) => Promise<Response>) {
  const client = await pool.connect(), key = kioskSessionKey(sessionId)
  let locked = false, accountLocked = false
  try {
    accountLocked = (await client.query<{ locked: boolean }>("select pg_try_advisory_lock_shared(hashtextextended($1,0)) as locked", [accountAccessKey(accountId)])).rows[0].locked
    if (!accountLocked) throw new AccountAccessError(429,"account_access_changing")
    await assertAccountActive(client,accountId)
    locked = (await client.query<{ locked: boolean }>("select pg_try_advisory_lock_shared(hashtextextended($1,0)) as locked", [key])).rows[0].locked
    if (!locked) throw new KioskError("Kiosk mode is changing. Please try again.", 429)
    const row = await readKioskForSession(client, accountId, sessionId)
    const deviceId = request.headers.get("X-Cyntch-Device")
    if ((!row || row.state === "unlocked") && deviceId && notificationUuid.test(deviceId)) {
      const active = (await client.query("select 1 from native_kiosk_sessions where device_id=$1 and state='locked'", [deviceId])).rows[0]
      if (active) throw new KioskError("Recover or unlock this device's kiosk before using this sign-in.", 423)
    }
    if (!row || row.state === "unlocked") return await work(request)
    const restricted = await restrictRequest(client, request, row)
    const responseRequest = restricted.clone()
    return await restrictResponse(client, responseRequest, await work(restricted), row)
  } finally {
    try {
      if (locked) await client.query("select pg_advisory_unlock_shared(hashtextextended($1,0))", [key])
      if (accountLocked) await client.query("select pg_advisory_unlock_shared(hashtextextended($1,0))", [accountAccessKey(accountId)])
      client.release()
    }
    catch { client.release(true) }
  }
}
export async function withNativeKioskRequest(request: Request, work: (request: Request) => Promise<Response>) {
  const { userId, sessionId } = await auth()
  if (!userId || !sessionId) return work(request)
  const expectedSession = request.headers.get("X-Cyntch-Session")
  if (expectedSession && expectedSession !== sessionId) return Response.json({ error: "Your sign-in changed. Please try again." }, { status: 403 })
  try { return await guardNativeKioskRequest(kioskGateDb, request, userId, sessionId, work) }
  catch (error) {
    if (error instanceof KioskError || error instanceof AccountAccessError) return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status, headers: { "Cache-Control": "no-store" } })
    console.error("[native-kiosk] Unable to check device restrictions", { name: error instanceof Error ? error.name : "UnknownError", code: (error as { code?: string })?.code })
    return Response.json({ error: "Unable to verify device access. Please try again." }, { status: 503 })
  }
}
