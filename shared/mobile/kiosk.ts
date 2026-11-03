import type { BoardSnapshot } from "./contracts"
import { notificationSessionId, notificationUuid } from "./notification-settings"

export interface NativeKioskSession {
  id: string; accountId: string; sessionId: string; deviceId: string; householdId: string;
  visibleMemberIds: string[]; editableMemberIds: string[]; state: "locked" | "unlocked" | "recovered";
}
export type NativeKioskOperation =
  | { action: "activate"; id: string; householdId: string; visibleMemberIds: string[]; editableMemberIds: string[]; exitSecret: string }
  | { action: "unlock"; id: string; exitSecret: string }
  | { action: "recover"; id: string }
export class KioskError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "KioskError" }
}
export function validateKioskIdentity(deviceId: string, sessionId: string) {
  if (!notificationUuid.test(deviceId) || !notificationSessionId.test(sessionId)) throw new KioskError("Sign in again on this device before changing kiosk mode.", 401)
}
export function parseKioskOperation(input: unknown): NativeKioskOperation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new KioskError("Choose valid kiosk settings.")
  const value = input as Record<string, unknown>
  if (typeof value.id !== "string" || !notificationUuid.test(value.id)) throw new KioskError("Choose a valid kiosk session.")
  if (value.action === "recover") return { action: "recover", id: value.id }
  if (typeof value.exitSecret !== "string" || !/^[a-f0-9]{64}$/.test(value.exitSecret)) throw new KioskError("The protected kiosk key is unavailable.")
  if (value.action === "unlock") return { action: "unlock", id: value.id, exitSecret: value.exitSecret }
  if (value.action !== "activate" || typeof value.householdId !== "string" || !notificationUuid.test(value.householdId)) throw new KioskError("Choose a valid kiosk household.")
  const ids = (input: unknown) => {
    if (!Array.isArray(input) || input.length > 500 || input.some(id => typeof id !== "string" || !id.length || id.length > 200)) throw new KioskError("Choose valid household members.")
    return [...new Set(input as string[])].sort()
  }
  const visibleMemberIds = ids(value.visibleMemberIds), editableMemberIds = ids(value.editableMemberIds)
  if (!visibleMemberIds.length || editableMemberIds.some(id => !visibleMemberIds.includes(id))) throw new KioskError("Choose visible members before allowing their tasks to be changed.")
  return { action: "activate", id: value.id, householdId: value.householdId, visibleMemberIds, editableMemberIds, exitSecret: value.exitSecret }
}

/** Shared by the API and local cache pruning. Empty selections never mean everyone. */
export function restrictKioskBoard(board: BoardSnapshot, kiosk: NativeKioskSession): BoardSnapshot | null {
  if (board.household.id !== kiosk.householdId) return null
  const visible = new Set(kiosk.visibleMemberIds)
  return { ...board, members: board.members.filter(member => visible.has(member.id)),
    tasks: board.tasks.filter(task => task.assignee_ids.some(id => visible.has(id))).map(task => ({ ...task,
      assignee_ids: task.assignee_ids.filter(id => visible.has(id)),
      // A prerequisite can belong to a hidden member; the restricted view must
      // not reveal its title through the task's availability explanation.
      blocking_task_title: null,
    })) }
}
