import { notificationCatalog, type DeviceNotificationPreferences, type MobileNotificationKind } from "./notification-catalog"
import { notificationSessionId, notificationUuid } from "./notification-settings"

/** Only identifiers and display policy metadata; never navigation URLs or names. */
export interface NativeNotificationPayload {
  version: 3; sessionId: string; deliveryId: string; accountId: string; householdId: string; eventId: string;
  kind: MobileNotificationKind; occurrenceId?: string; taskId?: string;
  hasDetails: boolean; memberSelectionHash: string | null; expiresAt: number;
}
export function notificationMemberSelection(preferences: DeviceNotificationPreferences, kind: MobileNotificationKind) {
  return JSON.stringify([...new Set(preferences.categories[kind]?.memberIds ?? [])].sort())
}
export function parseNativeNotificationPayload(value: unknown): NativeNotificationPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.version !== 3 || typeof row.sessionId !== "string" || !notificationSessionId.test(row.sessionId)
    || typeof row.accountId !== "string" || !row.accountId.length || row.accountId.length > 200
    || typeof row.kind !== "string" || !Object.hasOwn(notificationCatalog, row.kind)
    || typeof row.hasDetails !== "boolean" || !Number.isSafeInteger(row.expiresAt) || (row.expiresAt as number) <= 0) return null
  for (const key of ["deliveryId", "householdId", "eventId"]) if (typeof row[key] !== "string" || !notificationUuid.test(row[key])) return null
  const kind = row.kind as MobileNotificationKind
  const task = kind.startsWith("task_") || kind.startsWith("reward_"), run = task || kind.startsWith("routine_")
  if (run && (typeof row.occurrenceId !== "string" || !notificationUuid.test(row.occurrenceId))) return null
  if (task && (typeof row.taskId !== "string" || !notificationUuid.test(row.taskId))) return null
  if (notificationCatalog[kind].scope === "member"
    ? typeof row.memberSelectionHash !== "string" || !/^[a-f0-9]{64}$/.test(row.memberSelectionHash)
    : row.memberSelectionHash !== null) return null
  return { version: 3, sessionId: row.sessionId, accountId: row.accountId, deliveryId: row.deliveryId as string,
    householdId: row.householdId as string, eventId: row.eventId as string, kind, hasDetails: row.hasDetails,
    memberSelectionHash: row.memberSelectionHash as string | null, expiresAt: row.expiresAt as number,
    ...(run ? { occurrenceId: row.occurrenceId as string } : {}), ...(task ? { taskId: row.taskId as string } : {}) }
}
