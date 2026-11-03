import type { MemberRole } from "./contracts"
import { notificationCatalog, type DeviceNotificationPreferences, type MobileNotificationKind } from "./notification-catalog"

export type NotificationPermission = "undetermined" | "denied" | "granted" | "provisional"
export interface NativeNotificationDevice {
  accountId: string; deviceId: string; revision: string; platform: "android" | "ios" | null;
  permission: NotificationPermission; hasToken: boolean; deviceName: string | null; appVersion: string | null;
}
export interface NotificationSettingsSnapshot {
  accountId: string; deviceId: string; householdId: string; revision: string; configured: boolean;
  preferences: DeviceNotificationPreferences;
}
interface SettingOperation { operationId: string; baseRevision: string }
export interface RegisterNotificationDevice extends SettingOperation {
  action: "registerDevice"; platform: "android" | "ios"; permission: NotificationPermission;
  token: string | null; deviceName: string | null; appVersion: string | null;
}
export interface SaveNotificationPreferences extends SettingOperation {
  action: "savePreferences"; householdId: string; preferences: DeviceNotificationPreferences;
}
export type NotificationSettingsOperation = RegisterNotificationDevice | SaveNotificationPreferences
export class NotificationSettingsError extends Error { constructor(message: string, public status = 400) { super(message) } }
export const notificationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const notificationSessionId = /^sess_[A-Za-z0-9_-]{1,200}$/

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotificationSettingsError("Choose valid notification settings.")
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new NotificationSettingsError("The device details are invalid.")
  return value.trim() || null
}
export function parseNotificationPreferences(value: unknown): DeviceNotificationPreferences {
  const input = object(value), categories = object(input.categories)
  if (typeof input.enabled !== "boolean" || typeof input.showDetails !== "boolean" || typeof input.timezone !== "string" || input.timezone.length > 100) throw new NotificationSettingsError("Choose valid notification settings.")
  try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(0) }
  catch { throw new NotificationSettingsError("Choose a valid notification timezone.") }
  let quietHours: DeviceNotificationPreferences["quietHours"] = null
  if (input.quietHours !== null) {
    const hours = object(input.quietHours), clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/
    if (typeof hours.start !== "string" || typeof hours.end !== "string" || !clock.test(hours.start) || !clock.test(hours.end)) throw new NotificationSettingsError("Quiet hours must use valid times.")
    quietHours = { start: hours.start, end: hours.end }
  }
  for (const kind of Object.keys(categories)) if (!Object.hasOwn(notificationCatalog, kind)) throw new NotificationSettingsError("This notification type is not supported.")
  const parsed: DeviceNotificationPreferences["categories"] = {}
  for (const kind of Object.keys(notificationCatalog) as MobileNotificationKind[]) {
    const selection = categories[kind] === undefined ? { enabled: false, memberIds: [] } : object(categories[kind])
    if (typeof selection.enabled !== "boolean" || !Array.isArray(selection.memberIds) || selection.memberIds.length > 200 || selection.memberIds.some(id => typeof id !== "string" || !id.length || id.length > 200)) throw new NotificationSettingsError("Choose valid members for this notification.")
    const memberIds = [...new Set(selection.memberIds as string[])].sort()
    if (notificationCatalog[kind].scope === "household" && memberIds.length) throw new NotificationSettingsError("Household notifications do not use a member selection.")
    parsed[kind] = { enabled: selection.enabled, memberIds }
  }
  return { enabled: input.enabled, showDetails: input.showDetails, timezone: input.timezone, quietHours, categories: parsed }
}

export function parseNotificationSettingsOperation(value: unknown): NotificationSettingsOperation {
  const input = object(value)
  if (typeof input.operationId !== "string" || !notificationUuid.test(input.operationId) || typeof input.baseRevision !== "string" || !/^(0|[1-9]\d{0,18})$/.test(input.baseRevision) || BigInt(input.baseRevision) >= BigInt("9223372036854775807")) throw new NotificationSettingsError("This saved notification request is invalid.")
  const common = { operationId: input.operationId.toLowerCase(), baseRevision: input.baseRevision }
  if (input.action === "registerDevice") {
    if (input.platform !== "android" && input.platform !== "ios") throw new NotificationSettingsError("Choose a supported device platform.")
    if (!["undetermined", "denied", "granted", "provisional"].includes(String(input.permission))) throw new NotificationSettingsError("The notification permission is invalid.")
    if (input.permission === "provisional" && input.platform !== "ios") throw new NotificationSettingsError("Provisional permission is only available on iOS.")
    const token = text(input.token, 256)
    if (token && (!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token) || !["granted", "provisional"].includes(String(input.permission)))) throw new NotificationSettingsError("The notification token or permission is invalid.")
    return { ...common, action: "registerDevice", platform: input.platform, permission: input.permission as NotificationPermission,
      token, deviceName: text(input.deviceName, 100), appVersion: text(input.appVersion, 64) }
  }
  if (input.action !== "savePreferences" || typeof input.householdId !== "string" || !notificationUuid.test(input.householdId)) throw new NotificationSettingsError("Choose a valid household and notification action.")
  return { ...common, action: "savePreferences", householdId: input.householdId.toLowerCase(), preferences: parseNotificationPreferences(input.preferences) }
}

/** Current membership always limits stored selections, including after a role change. */
export function restrictNotificationPreferences(preferences: DeviceNotificationPreferences, userId: string, role: MemberRole, memberIds: string[]): DeviceNotificationPreferences {
  const allowed = new Set(role === "member" ? memberIds.filter(id => id === userId) : memberIds)
  return { ...preferences, categories: Object.fromEntries((Object.keys(notificationCatalog) as MobileNotificationKind[]).map(kind => {
    const category = notificationCatalog[kind], selected = preferences.categories[kind] ?? { enabled: false, memberIds: [] }
    return [kind, { enabled: selected.enabled && !(category.managementOnly && role !== "manager") && !(category.scope === "household" && role === "member"),
      memberIds: selected.memberIds.filter(id => allowed.has(id)) }]
  })) }
}
