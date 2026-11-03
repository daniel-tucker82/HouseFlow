import { createHash, timingSafeEqual } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { normalizeRole } from "@/lib/household-authz"
import { verifyInstallation } from "@/lib/native-notification-settings"
import { KioskError, parseKioskOperation, validateKioskIdentity, type NativeKioskSession } from "@/shared/mobile/kiosk"
import { accountAccessKey, AccountAccessError, assertAccountActive } from "@/lib/account-access"

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
  if ((await client.query("select 1 from native_kiosk_recoveries where user_id=$1 and session_id=$2 limit 1", [accountId, sessionId])).rows[0]) {
    throw new KioskError("This sign-in session has ended. Sign in again.", 401)
  }
  return (await client.query<KioskRow>("select * from native_kiosk_sessions where user_id=$1 and session_id=$2 order by sequence desc limit 1", [accountId, sessionId])).rows[0] ?? null
}
export async function readNativeKiosk(pool: Pool, accountId: string, sessionId: string, deviceId: string, secret: string) {
  validateKioskIdentity(deviceId, sessionId)
  const client = await pool.connect()
  try {
    await client.query("begin")
    if (!(await client.query("select pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) as acquired",[accountAccessKey(accountId)])).rows[0].acquired) throw new AccountAccessError(429,"account_access_changing")
    await assertAccountActive(client,accountId)
    await verifyInstallation(client, deviceId, secret)
    const previous = await readKioskForSession(client, accountId, sessionId)
    if (previous?.state === "recovered") throw new KioskError("This sign-in session has ended. Sign in again.", 401)
    const row = (await client.query<KioskRow>("select * from native_kiosk_sessions where device_id=$1 and state='locked'", [deviceId])).rows[0]
      ?? previous
    if (row && (row.user_id !== accountId || row.device_id !== deviceId)) throw new KioskError("Sign in with the parent account that enabled kiosk mode.", 403)
    await client.query("commit")
    return { kiosk: row ? kioskSnapshot(row) : null }
  } catch (error) {await client.query("rollback");throw error} finally { client.release() }
}

/** Account admission precedes session, operation, device and household locks. */
export async function saveNativeKiosk(pool: Pool, accountId: string, sessionId: string, deviceId: string, secret: string, input: unknown) {
  validateKioskIdentity(deviceId, sessionId)
  const operation = parseKioskOperation(input), client = await pool.connect()
  try {
    await client.query("begin")
    await client.query("set local lock_timeout='5s'")
    if (!(await client.query("select pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) as acquired",[accountAccessKey(accountId)])).rows[0].acquired) throw new AccountAccessError(429,"account_access_changing")
    await assertAccountActive(client,accountId)
    // Recovery retires the old authenticated session. Lock that session before
    // the installation so an earlier task request finishes before recovery.
    const protectedSession = operation.action === "recover" ? operation.previousSessionId : sessionId
    if (operation.action === "recover" && protectedSession === sessionId) throw new KioskError("Sign out and authenticate the parent account again to recover the kiosk PIN.", 403)
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [kioskSessionKey(protectedSession)])
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`native-kiosk-operation:${operation.id}`])
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`native-device:${deviceId}`])
    await verifyInstallation(client, deviceId, secret, true)
    const previous = await readKioskForSession(client, accountId, sessionId)
    let row = (await client.query<KioskRow>("select * from native_kiosk_sessions where id=$1 for update", [operation.id])).rows[0]
    if (row && (row.user_id !== accountId || row.device_id !== deviceId)) throw new KioskError("This kiosk belongs to a different parent or device.", 403)
    const receipt = (await client.query<{ user_id: string; device_id: string; session_id: string }>("select user_id,device_id,session_id from native_kiosk_recoveries where kiosk_id=$1", [operation.id])).rows[0]
    const cancellation = (await client.query<{ user_id: string; device_id: string; session_id: string; exit_secret_hash: string }>("select * from native_kiosk_cancellations where kiosk_id=$1", [operation.id])).rows[0]
    if (cancellation && (cancellation.user_id !== accountId || cancellation.device_id !== deviceId || cancellation.session_id !== protectedSession)) throw new KioskError("This kiosk request belongs to a different sign-in or device.", 409)
    if (operation.action === "recover") {
      if ((row && row.session_id !== protectedSession) || (receipt && (receipt.user_id !== accountId || receipt.device_id !== deviceId || receipt.session_id !== protectedSession))) throw new KioskError("This recovery does not match the original kiosk.", 409)
      if (previous && previous.state !== "unlocked") throw new KioskError("Use a new parent sign-in to recover this kiosk.", 403)
      if ((await client.query("select 1 from native_kiosk_sessions where device_id=$1 and state='locked' and id<>$2", [deviceId, operation.id])).rows[0]) throw new KioskError("This device has a newer kiosk lock. Recover that lock instead.", 409)
      await client.query(`insert into native_kiosk_recoveries(kiosk_id,user_id,device_id,session_id,recovered_by_session_id)
        values($1,$2,$3,$4,$5) on conflict(kiosk_id) do nothing`, [operation.id, accountId, deviceId, protectedSession, sessionId])
      if (row?.state === "locked") row = (await client.query<KioskRow>("update native_kiosk_sessions set state='recovered',ended_at=now() where id=$1 returning *", [row.id])).rows[0]
      await client.query(`update native_notification_devices set permission='denied',expo_push_token=null,session_id=null,revision=revision+1,updated_at=now()
        where device_id=$1 and user_id=$2 and session_id=$3`, [deviceId, accountId, protectedSession])
      await client.query(`update native_notification_deliveries set state='suppressed',lease_id=null,lease_until=null
        where device_id=$1 and user_id=$2 and session_id=$3 and state in ('queued','sending')`, [deviceId, accountId, protectedSession])
      await client.query("commit")
      return { kiosk: row ? kioskSnapshot(row) : null, recovery: { id: operation.id, accountId, deviceId, sessionId: protectedSession } }
    }
    if (receipt) throw new KioskError("This kiosk activation has been recovered. Create a new kiosk session.", 409)
    if (operation.action === "activate") {
      if (cancellation) throw new KioskError("This kiosk activation was cancelled. Create a new kiosk session.", 409)
      const requestHash = hash(JSON.stringify(operation))
      if (row) {
        if (row.session_id !== sessionId || row.request_hash !== requestHash) throw new KioskError("This kiosk request has already been used for different settings.", 409)
        if (row.state === "recovered") throw new KioskError("This sign-in session has ended. Sign in again.", 401)
      } else {
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
      if (!row) {
        const exitHash = hash(operation.exitSecret)
        if (cancellation && !timingSafeEqual(Buffer.from(cancellation.exit_secret_hash, "hex"), Buffer.from(exitHash, "hex"))) throw new KioskError("The protected kiosk key does not match.", 403)
        await client.query(`insert into native_kiosk_cancellations(kiosk_id,user_id,device_id,session_id,exit_secret_hash)
          values($1,$2,$3,$4,$5) on conflict(kiosk_id) do nothing`, [operation.id, accountId, deviceId, sessionId, exitHash])
        await client.query("commit")
        return { kiosk: null, cancelledActivation: { id: operation.id, accountId, deviceId, sessionId } }
      }
      if (row.session_id !== sessionId || row.state === "recovered") throw new KioskError("Sign in with the parent account to recover this kiosk.", 401)
      if (!timingSafeEqual(Buffer.from(row.exit_secret_hash, "hex"), Buffer.from(hash(operation.exitSecret), "hex"))) throw new KioskError("The protected kiosk key does not match.", 403)
      if (row.state === "locked") {
        row = (await client.query<KioskRow>("update native_kiosk_sessions set state='unlocked',ended_at=now() where id=$1 returning *", [row.id])).rows[0]
      }
    }
    await client.query("commit")
    return { kiosk: kioskSnapshot(row) }
  } catch (error) { await client.query("rollback"); throw error } finally { client.release() }
}
