import { createHash, timingSafeEqual } from "node:crypto"
import type { PoolClient } from "pg"
import { db } from "@/lib/db"
import { normalizeRole } from "@/lib/household-authz"
import { defaultNotificationPreferences, type DeviceNotificationPreferences } from "@/shared/mobile/notification-catalog"
import { NotificationSettingsError, notificationUuid, parseNotificationSettingsOperation, restrictNotificationPreferences,
  type NativeNotificationDevice, type NotificationSettingsSnapshot, type NotificationSettingsOperation } from "@/shared/mobile/notification-settings"

type DeviceRow = { revision: string; platform: "android" | "ios"; permission: NativeNotificationDevice["permission"]; has_token: boolean; device_name: string | null; app_version: string | null }
const deviceSelect = `select revision::text,platform,permission,expo_push_token is not null as has_token,device_name,app_version
  from native_notification_devices where user_id=$1 and device_id=$2`
function deviceSnapshot(accountId: string, deviceId: string, row?: DeviceRow): NativeNotificationDevice {
  return { accountId, deviceId, revision: row?.revision ?? "0", platform: row?.platform ?? null, permission: row?.permission ?? "undetermined",
    hasToken: row?.has_token ?? false, deviceName: row?.device_name ?? null, appVersion: row?.app_version ?? null }
}
function checkDeviceId(deviceId: string) { if (!notificationUuid.test(deviceId)) throw new NotificationSettingsError("Choose a valid device.") }
async function verifyInstallation(client: PoolClient, deviceId: string, secret: string, create = false) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new NotificationSettingsError("This device's secure registration is missing.", 403)
  const hash = createHash("sha256").update(secret).digest("hex")
  const stored = (await client.query<{ secret_hash: string }>("select secret_hash from native_notification_installations where device_id=$1", [deviceId])).rows[0]
  if (stored && !timingSafeEqual(Buffer.from(stored.secret_hash, "hex"), Buffer.from(hash, "hex"))) throw new NotificationSettingsError("This device's secure registration does not match.", 403)
  if (!stored && create) await client.query("insert into native_notification_installations(device_id,secret_hash) values($1,$2)", [deviceId, hash])
}
async function membership(client: PoolClient, userId: string, householdId: string, lock = false) {
  const row = (await client.query<{ role: string; timezone: string }>(`select hm.role,h.timezone from household_members hm join households h on h.id=hm.household_id
    where hm.household_id=$1 and hm.user_id=$2${lock ? " for share of hm" : ""}`, [householdId, userId])).rows[0]
  if (!row) throw new NotificationSettingsError("Household access is no longer available.", 403)
  const memberIds = (await client.query<{ user_id: string }>("select user_id from household_members where household_id=$1", [householdId])).rows.map(member => member.user_id)
  return { role: normalizeRole(row.role), timezone: row.timezone || "UTC", memberIds }
}

export async function readNativeNotificationSettings(userId: string, deviceId: string, installationSecret: string, householdId?: string | null) {
  checkDeviceId(deviceId)
  if (householdId && !notificationUuid.test(householdId)) throw new NotificationSettingsError("Choose a valid household.")
  const client = await db.connect()
  try {
    await client.query("begin isolation level repeatable read read only")
    await verifyInstallation(client, deviceId, installationSecret)
    const device = deviceSnapshot(userId, deviceId, (await client.query<DeviceRow>(deviceSelect, [userId, deviceId])).rows[0])
    let settings: NotificationSettingsSnapshot | null = null
    if (householdId) {
      const access = await membership(client, userId, householdId)
      const row = (await client.query<{ revision: string; preferences: DeviceNotificationPreferences }>(`select revision::text,preferences from native_notification_preferences
        where user_id=$1 and device_id=$2 and household_id=$3`, [userId, deviceId, householdId])).rows[0]
      const defaults = defaultNotificationPreferences(userId, access.timezone)
      defaults.enabled = device.hasToken && ["granted", "provisional"].includes(device.permission)
      settings = { accountId: userId, deviceId, householdId, revision: row?.revision ?? "0", configured: Boolean(row),
        preferences: restrictNotificationPreferences(row?.preferences ?? defaults, userId, access.role, access.memberIds) }
    }
    await client.query("commit")
    return { device, settings }
  } catch (error) { await client.query("rollback"); throw error } finally { client.release() }
}

/** Frozen operation IDs and revisions protect token rotation, sign-out and preference retries. */
export async function saveNativeNotificationSettings(userId: string, deviceId: string, installationSecret: string, input: unknown) {
  checkDeviceId(deviceId)
  const operation = parseNotificationSettingsOperation(input)
  const hash = createHash("sha256").update(JSON.stringify(operation)).digest("hex")
  const client = await db.connect()
  try {
    await client.query("begin")
    // One physical installation can change accounts; serialize those registrations too.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`native-device:${deviceId}`])
    await verifyInstallation(client, deviceId, installationSecret, operation.action === "registerDevice")
    const access = operation.action === "savePreferences" ? await membership(client, userId, operation.householdId, true) : null
    const receipt = (await client.query<{ request_hash: string; result: { device?: NativeNotificationDevice; settings?: NotificationSettingsSnapshot } }>(`select request_hash,result from native_notification_operations
      where user_id=$1 and device_id=$2 and operation_id=$3`, [userId, deviceId, operation.operationId])).rows[0]
    if (receipt) {
      if (receipt.request_hash !== hash) throw new NotificationSettingsError("This saved request was already used for different notification settings.", 409)
      // Replays acknowledge the prior save without reactivating an old token or rewriting newer preferences.
      const replay = { ...receipt.result }
      if (replay.settings && access) replay.settings = { ...replay.settings, preferences: restrictNotificationPreferences(replay.settings.preferences, userId, access.role, access.memberIds) }
      await client.query("commit"); return { ...replay, replayed: true }
    }
    let result: { device?: NativeNotificationDevice; settings?: NotificationSettingsSnapshot }
    if (operation.action === "registerDevice") result = { device: await register(client, userId, deviceId, operation) }
    else {
      const device = (await client.query(deviceSelect, [userId, deviceId])).rows[0]
      if (!device) throw new NotificationSettingsError("Register this device before saving its notifications.", 409)
      const preferences = restrictNotificationPreferences(operation.preferences, userId, access!.role, access!.memberIds)
      if (JSON.stringify(preferences) !== JSON.stringify(operation.preferences)) throw new NotificationSettingsError("You can only choose notifications for members and events your current role can access.", 403)
      const row = (await client.query<{ revision: string }>(`select revision::text from native_notification_preferences where user_id=$1 and device_id=$2 and household_id=$3`, [userId, deviceId, operation.householdId])).rows[0]
      if ((row?.revision ?? "0") !== operation.baseRevision) throw new NotificationSettingsError("These notification settings changed. Refresh them before saving again.", 409)
      const saved = (await client.query<{ revision: string }>(`insert into native_notification_preferences(user_id,device_id,household_id,preferences) values($1,$2,$3,$4::jsonb)
        on conflict(user_id,device_id,household_id) do update set preferences=excluded.preferences,revision=native_notification_preferences.revision+1,updated_at=now()
        returning revision::text`, [userId, deviceId, operation.householdId, JSON.stringify(preferences)])).rows[0]
      result = { settings: { accountId: userId, deviceId, householdId: operation.householdId, revision: saved.revision, configured: true, preferences } }
    }
    await client.query(`insert into native_notification_operations(user_id,device_id,operation_id,action,household_id,request_hash,result) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [userId, deviceId, operation.operationId, operation.action, operation.action === "savePreferences" ? operation.householdId : null, hash, JSON.stringify(result)])
    await client.query("commit")
    return { ...result, replayed: false }
  } catch (error) { await client.query("rollback"); throw error } finally { client.release() }
}

async function register(client: PoolClient, userId: string, deviceId: string, operation: Extract<NotificationSettingsOperation, { action: "registerDevice" }>) {
  if (operation.token) await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`native-token:${operation.token}`])
  const current = (await client.query<DeviceRow>(`${deviceSelect} for update`, [userId, deviceId])).rows[0]
  if ((current?.revision ?? "0") !== operation.baseRevision) throw new NotificationSettingsError("This device registration changed. Refresh it before saving again.", 409)
  await client.query(`update native_notification_devices set expo_push_token=null,revision=revision+1,updated_at=now()
    where device_id=$1 and user_id<>$2`, [deviceId, userId])
  // Account switches or reinstallations must never deliver the same token to two accounts.
  // Bump the former registration's revision so its delayed unsent update cannot reclaim it.
  if (operation.token) await client.query(`update native_notification_devices set expo_push_token=null,revision=revision+1,updated_at=now()
    where expo_push_token=$1 and (user_id<>$2 or device_id<>$3)`, [operation.token, userId, deviceId])
  await client.query(`insert into native_notification_devices(user_id,device_id,platform,permission,expo_push_token,device_name,app_version)
    values($1,$2,$3,$4,$5,$6,$7) on conflict(user_id,device_id) do update set platform=excluded.platform,permission=excluded.permission,
    expo_push_token=excluded.expo_push_token,device_name=excluded.device_name,app_version=excluded.app_version,revision=native_notification_devices.revision+1,updated_at=now()`,
    [userId, deviceId, operation.platform, operation.permission, operation.token, operation.deviceName, operation.appVersion])
  return deviceSnapshot(userId, deviceId, (await client.query<DeviceRow>(deviceSelect, [userId, deviceId])).rows[0])
}
