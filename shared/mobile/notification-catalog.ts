import type { MemberRole } from "./contracts"

export const notificationCatalog = {
  task_available: { label: "Tasks become startable", scope: "member", managementOnly: false, ownDefault: true },
  task_completed: { label: "Tasks marked complete", scope: "member", managementOnly: false, ownDefault: false },
  task_reopened: { label: "Tasks marked incomplete", scope: "member", managementOnly: false, ownDefault: false },
  task_assigned: { label: "Task assignments", scope: "member", managementOnly: false, ownDefault: false },
  task_completed_automatically: { label: "Tasks completed by expiry rules", scope: "member", managementOnly: false, ownDefault: false },
  reward_available: { label: "Rewards become available", scope: "member", managementOnly: false, ownDefault: true },
  reward_completed: { label: "Rewards marked complete", scope: "member", managementOnly: false, ownDefault: false },
  routine_generated: { label: "Recurring routines created", scope: "household", managementOnly: false, ownDefault: false },
  routine_started: { label: "Routines started manually", scope: "household", managementOnly: false, ownDefault: false },
  routine_completed: { label: "Routines completed through tasks", scope: "household", managementOnly: false, ownDefault: false },
  routine_superseded: { label: "Older routines completed automatically", scope: "household", managementOnly: false, ownDefault: false },
  routine_reopened: { label: "Routines become incomplete again", scope: "household", managementOnly: false, ownDefault: false },
  member_joined: { label: "Members join by invitation", scope: "household", managementOnly: true, ownDefault: false },
  member_added: { label: "Profiles added without email", scope: "household", managementOnly: true, ownDefault: false },
  member_left: { label: "Members leave or are removed", scope: "household", managementOnly: true, ownDefault: false },
} as const

export type MobileNotificationKind = keyof typeof notificationCatalog

export interface DeviceNotificationPreferences {
  enabled: boolean
  showDetails: boolean
  timezone: string
  quietHours: { start: string; end: string } | null
  categories: Partial<Record<MobileNotificationKind, { enabled: boolean; memberIds: string[] }>>
}

export function defaultNotificationPreferences(userId: string, timezone: string, kiosk = false): DeviceNotificationPreferences {
  return {
    enabled: !kiosk, showDetails: false, timezone, quietHours: null,
    categories: Object.fromEntries(Object.entries(notificationCatalog).map(([kind, item]) => [kind, {
      enabled: !kiosk && item.ownDefault, memberIds: item.scope === "member" ? [userId] : [],
    }])),
  }
}

export function inQuietHours(preferences: DeviceNotificationPreferences, now: Date) {
  if (!preferences.quietHours) return false
  const { start, end } = preferences.quietHours
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) return false
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: preferences.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now)
  const time = `${parts.find(p => p.type === "hour")?.value}:${parts.find(p => p.type === "minute")?.value}`
  if (start === end) return true
  return start < end ? time >= start && time < end : time >= start || time < end
}

export function shouldPushNotification(options: {
  kind: MobileNotificationKind; memberIds: string[]; userId: string; role: MemberRole;
  preferences: DeviceNotificationPreferences; now: Date;
}) {
  const { kind, memberIds, userId, role, preferences, now } = options
  const category = notificationCatalog[kind]
  const selection = preferences.categories[kind]
  if (!preferences.enabled || !selection?.enabled || inQuietHours(preferences, now)) return false
  if (category.managementOnly && role !== "manager") return false
  if (category.scope === "household") return role !== "member"
  const allowedIds = role === "member" ? [userId] : selection.memberIds
  return memberIds.some(id => allowedIds.includes(id) && selection.memberIds.includes(id))
}
