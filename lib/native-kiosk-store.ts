import { createHash, timingSafeEqual } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { normalizeRole } from "@/lib/household-authz"
import { verifyInstallation } from "@/lib/native-notification-settings"
import { KioskError, parseKioskOperation, validateKioskIdentity, type NativeKioskSession } from "@/shared/mobile/kiosk"

export interface KioskRow {
  id: string; user_id: string; session_id: string; device_id: string; household_id: string;
  visible_member_ids: string[]; editable_member_ids: string[]; state: NativeKioskSession["state"];
  exit_secret_hash: string; request_hash: string;
}
export const kioskSessionKey = (sessionId: string) => `native-kiosk:${sessionId}`
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
export function kioskSnapshot(row: KioskRow): NativeKioskSession {
  return { id: row.id, accountId: row.user_id, sessionId: row.session_id, deviceId: row.device_id, householdId: row.household_id,
    visibleMemberIds: row.visible_member_ids, editableMemberIds: row.editable_member_ids, state: row.state }
}
export async function readKioskForSession(client: PoolClient, accountId: string, sessionId: string) {
  return (await client.query<KioskRow>("select * from native_kiosk_sessions where user_id=$1 and session_id=$2 order by sequence desc limit 1", [accountId, sessionId])).rows[0] ?? null
}
export async function readNativeKiosk(pool: Pool, accountId: string, sessionId: string, deviceId: string, secret: string) {
  validateKioskIdentity(deviceId, sessionId)
  const client = await pool.connect()
  try {
    await verifyInstallation(client, deviceId, secret)
    const previous = await readKioskForSession(client, accountId, sessionId)
    if (previous?.state === "recovered") throw new KioskError("This sign-in session has ended. Sign in again.", 401)
    const row = (await client.query<KioskRow>("select * from native_kiosk_sessions where device_id=$1 and state='locked'", [deviceId])).rows[0]
      ?? previous
    if (row && (row.user_id !== accountId || row.device_id !== deviceId)) throw new KioskError("Sign in with the parent account that enabled kiosk mode.", 403)
    return { kiosk: row ? kioskSnapshot(row) : null }
  } finally { client.release() }
}

/** Session lock precedes device and household locks, also used by protected requests. */
export async function saveNativeKiosk(pool: Pool, accountId: string, sessionId: string, deviceId: string, secret: string, input: unknown) {
  validateKioskIdentity(deviceId, sessionId)
  const operation = parseKioskOperation(input), client = await pool.connect()
  try {
    await client.query("begin")
    await client.query("set local lock_timeout='5s'")
    // Recovery retires the old authenticated session. Lock that session before
    // the installation so an earlier task request finishes before recovery.
    const target = operation.action === "recover" ? (await client.query<KioskRow>("select * from native_kiosk_sessions where id=$1", [operation.id])).rows[0] : null
    if (target && (target.user_id !== accountId || target.device_id !== deviceId)) throw new KioskError("This kiosk belongs to a different parent or device.", 403)
    const protectedSession = target?.session_id ?? sessionId
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [kioskSessionKey(protectedSession)])
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`native-device:${deviceId}`])
    await verifyInstallation(client, deviceId, secret, operation.action === "activate")
    let row = (await client.query<KioskRow>("select * from native_kiosk_sessions where id=$1 for update", [operation.id])).rows[0]
    if (row && (row.user_id !== accountId || row.device_id !== deviceId)) throw new KioskError("This kiosk belongs to a different parent or device.", 403)
    if (operation.action === "activate") {
      const requestHash = hash(JSON.stringify(operation))
      if (row) {
        if (row.session_id !== sessionId || row.request_hash !== requestHash) throw new KioskError("This kiosk request has already been used for different settings.", 409)
        if (row.state === "recovered") throw new KioskError("This sign-in session has ended. Sign in again.", 401)
      } else {
        const previous = await readKioskForSession(client, accountId, sessionId)
        if (previous?.state === "recovered") throw new KioskError("This sign-in session has ended. Sign in again.", 401)
        const active = (await client.query("select 1 from native_kiosk_sessions where state='locked' and (device_id=$1 or (user_id=$2 and session_id=$3))", [deviceId, accountId, sessionId])).rows[0]
        if (active) throw new KioskError("Unlock the current kiosk before changing its configuration.", 423)
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [operation.householdId])
        const membership = (await client.query<{ role: string }>("select role from household_members where household_id=$1 and user_id=$2 for share", [operation.householdId, accountId])).rows[0]
        if (!membership || normalizeRole(membership.role) !== "manager") throw new KioskError("Only a household manager can enable kiosk mode.", 403)
        const members = (await client.query<{ user_id: string }>("select user_id from household_members where household_id=$1", [operation.householdId])).rows.map(member => member.user_id)
        if (operation.visibleMemberIds.some(id => !members.includes(id))) throw new KioskError("A selected member is no longer in this household.", 409)
        row = (await client.query<KioskRow>(`insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [operation.id, accountId, sessionId, deviceId, operation.householdId, operation.visibleMemberIds, operation.editableMemberIds, hash(operation.exitSecret), requestHash])).rows[0]
        // Quiet shared screens do not replay a backlog after they are unlocked.
        await client.query("update native_notification_deliveries set state='suppressed',lease_id=null,lease_until=null where device_id=$1 and state in ('queued','sending')", [deviceId])
      }
    } else {
      if (!row) throw new KioskError("This kiosk session is no longer available.", 404)
      if (operation.action === "unlock") {
        if (row.session_id !== sessionId || row.state === "recovered") throw new KioskError("Sign in with the parent account to recover this kiosk.", 401)
        if (!timingSafeEqual(Buffer.from(row.exit_secret_hash, "hex"), Buffer.from(hash(operation.exitSecret), "hex"))) throw new KioskError("The protected kiosk key does not match.", 403)
      } else {
        if (row.session_id === sessionId) throw new KioskError("Sign out and authenticate the parent account again to recover the kiosk PIN.", 403)
        const current = await readKioskForSession(client, accountId, sessionId)
        if (current && current.state !== "unlocked") throw new KioskError("Use a new parent sign-in to recover this kiosk.", 403)
      }
      if (row.state === "locked") {
        row = (await client.query<KioskRow>("update native_kiosk_sessions set state=$2,ended_at=now() where id=$1 returning *", [row.id, operation.action === "recover" ? "recovered" : "unlocked"])).rows[0]
        if (operation.action === "recover") await client.query(`update native_notification_devices set permission='denied',expo_push_token=null,session_id=null,revision=revision+1,updated_at=now()
          where device_id=$1 and user_id=$2 and session_id=$3`, [deviceId, accountId, row.session_id])
      }
    }
    await client.query("commit")
    return { kiosk: kioskSnapshot(row) }
  } catch (error) { await client.query("rollback"); throw error } finally { client.release() }
}
