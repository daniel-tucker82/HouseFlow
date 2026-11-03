import type { BoardSnapshot } from "./contracts"
import { notificationSessionId, notificationUuid } from "./notification-settings"

export interface NativeKioskSession {
  id: string; accountId: string; sessionId: string; deviceId: string; householdId: string;
  visibleMemberIds: string[]; editableMemberIds: string[]; state: "locked" | "unlocked" | "recovered";
}
export type NativeKioskOperation =
  | { action: "activate"; id: string; householdId: string; visibleMemberIds: string[]; editableMemberIds: string[]; exitSecret: string }
  | { action: "unlock"; id: string; exitSecret: string }
  | { action: "recover"; id: string; previousSessionId: string }
export interface NativeKioskRecovery {
  id: string; accountId: string; deviceId: string; sessionId: string;
}
export interface NativeKioskResult { kiosk: NativeKioskSession | null; recovery?: NativeKioskRecovery; cancelledActivation?: NativeKioskRecovery }
export class KioskError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: "kiosk_access_changed") { super(message); this.name = "KioskError" }
}
export function validateKioskIdentity(deviceId: string, sessionId: string) {
  if (!notificationUuid.test(deviceId) || !notificationSessionId.test(sessionId)) throw new KioskError("Sign in again on this device before changing kiosk mode.", 401)
}
export function parseNativeKioskSession(input: unknown): NativeKioskSession {
  if (!input || typeof input !== "object") throw new KioskError("The device lock could not be read safely.")
  const value = input as Record<string, unknown>
  if (typeof value.accountId !== "string" || !value.accountId || typeof value.deviceId !== "string" || typeof value.sessionId !== "string"
    || !["locked", "unlocked", "recovered"].includes(String(value.state))) throw new KioskError("The device lock could not be read safely.")
  validateKioskIdentity(value.deviceId, value.sessionId)
  const settings = parseKioskSettings({ ...value, action: "activate", exitSecret: "0".repeat(64) },true)
  if (settings.action !== "activate") throw new KioskError("The device lock could not be read safely.")
  return { id: settings.id, accountId: value.accountId, deviceId: value.deviceId, sessionId: value.sessionId,
    householdId: settings.householdId, visibleMemberIds: settings.visibleMemberIds, editableMemberIds: settings.editableMemberIds, state: value.state as NativeKioskSession["state"] }
}
export function parseKioskOperation(input: unknown): NativeKioskOperation {
  return parseKioskSettings(input,false)
}
function parseKioskSettings(input: unknown, allowEmpty: boolean): NativeKioskOperation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new KioskError("Choose valid kiosk settings.")
  const value = input as Record<string, unknown>
  if (typeof value.id !== "string" || !notificationUuid.test(value.id)) throw new KioskError("Choose a valid kiosk session.")
  if (value.action === "recover") {
    if (typeof value.previousSessionId !== "string" || !notificationSessionId.test(value.previousSessionId)) throw new KioskError("The original kiosk sign-in is unavailable.")
    return { action: "recover", id: value.id, previousSessionId: value.previousSessionId }
  }
  if (typeof value.exitSecret !== "string" || !/^[a-f0-9]{64}$/.test(value.exitSecret)) throw new KioskError("The protected kiosk key is unavailable.")
  if (value.action === "unlock") return { action: "unlock", id: value.id, exitSecret: value.exitSecret }
  if (value.action !== "activate" || typeof value.householdId !== "string" || !notificationUuid.test(value.householdId)) throw new KioskError("Choose a valid kiosk household.")
  const ids = (input: unknown) => {
    if (!Array.isArray(input) || input.length > 500 || input.some(id => typeof id !== "string" || !id.length || id.length > 200)) throw new KioskError("Choose valid household members.")
    return [...new Set(input as string[])].sort()
  }
  const visibleMemberIds = ids(value.visibleMemberIds), editableMemberIds = ids(value.editableMemberIds)
  if ((!allowEmpty && !visibleMemberIds.length) || editableMemberIds.some(id => !visibleMemberIds.includes(id))) throw new KioskError("Choose visible members before allowing their tasks to be changed.")
  return { action: "activate", id: value.id, householdId: value.householdId, visibleMemberIds, editableMemberIds, exitSecret: value.exitSecret }
}

/** Shared by the API and local cache pruning. Empty selections never mean everyone. */
export function restrictKioskBoard(board: BoardSnapshot, kiosk: NativeKioskSession): BoardSnapshot | null {
  if (board.household.id !== kiosk.householdId) return null
  const visible = new Set(kiosk.visibleMemberIds)
  const tasks = board.tasks.filter(task => task.assignee_ids.some(id => visible.has(id)))
  const permittedTasks = new Set(tasks.map(task => `${task.occurrence_id}:${task.id}`))
  return { ...board, members: board.members.filter(member => visible.has(member.id)),
    tasks: tasks.map(task => {
      const permittedBlocker = task.blocking_task_id && permittedTasks.has(`${task.occurrence_id}:${task.blocking_task_id}`)
      return { ...task, assignee_ids: task.assignee_ids.filter(id => visible.has(id)),
        // Older caches without a blocker ID cannot prove that its details belong
        // to a permitted task. Hidden prerequisite IDs and assignees are private too.
        blocking_task_id: permittedBlocker ? task.blocking_task_id : null,
        blocking_task_title: permittedBlocker ? task.blocking_task_title : null,
        blocking_task_assignee_ids: permittedBlocker ? (task.blocking_task_assignee_ids ?? []).filter(id => visible.has(id)) : [],
      }
    }) }
}
