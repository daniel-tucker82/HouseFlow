import type { MemberRole } from "./contracts"
import { notificationCatalog, type DeviceNotificationPreferences, type MobileNotificationKind } from "./notification-catalog"

export type NotificationHistorySource = "app" | "web"
export interface NotificationHistoryScope { accountId: string; sessionId: string; deviceId: string; householdId: string }
export interface NotificationHistoryPoint { time: string; id: string }
export interface NotificationHistoryItem {
  id: string; kind: MobileNotificationKind | string; title: string; body: string;
  createdAt: string; read: boolean; occurrenceId?: string; taskId?: string;
}
export interface NotificationHistoryPage extends NotificationHistoryScope {
  source: NotificationHistorySource; role: MemberRole; filterKey: string; items: NotificationHistoryItem[];
  nextCursor: string | null; through: NotificationHistoryPoint; fetchedAt: string;
}
export type NotificationHistoryAction = { source: NotificationHistorySource; householdId: string } & (
  | { action: "read" | "dismiss"; notificationId: string }
  | { action: "readAll" | "dismissAll"; through: NotificationHistoryPoint }
)

export function notificationHistorySelections(role: MemberRole, preferences: DeviceNotificationPreferences) {
  return Object.entries(notificationCatalog).flatMap(([kind, category]) => {
    const selected = preferences.categories[kind as MobileNotificationKind]
    return selected?.enabled && (!category.managementOnly || role === "manager") && (category.scope !== "household" || role !== "member")
      ? [{ kind, household: category.scope === "household", members: [...selected.memberIds].sort() }] : []
  })
}
export function notificationHistoryFilterKey(role: MemberRole, selections: ReturnType<typeof notificationHistorySelections>, source: NotificationHistorySource) {
  return JSON.stringify([role, source === "app" ? selections : []])
}

export const notificationHistoryBodies: Record<MobileNotificationKind, string> = {
  task_available: "A task is ready to start.", task_completed: "A task was marked complete.",
  task_reopened: "A task was marked incomplete.", task_assigned: "A task was assigned.",
  task_completed_automatically: "A task was completed by its expiry rule.",
  reward_available: "A reward is available.", reward_completed: "A reward was marked complete.",
  routine_generated: "A recurring routine was created.", routine_started: "A routine was started.",
  routine_completed: "A routine was completed through its tasks.",
  routine_superseded: "An older routine was completed because a newer copy was created.",
  routine_reopened: "A routine has incomplete tasks again.",
  member_joined: "A member joined your household.", member_added: "A profile was added to your household.",
  member_left: "A member left or was removed from your household.",
}
