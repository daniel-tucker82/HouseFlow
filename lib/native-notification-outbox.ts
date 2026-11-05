import { createHash, randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { normalizeRole } from "@/lib/household-authz"
import { defaultNotificationPreferences, notificationCatalog, shouldPushNotification, type DeviceNotificationPreferences, type MobileNotificationKind } from "@/shared/mobile/notification-catalog"
import { notificationMemberSelection, type NativeNotificationPayload } from "@/shared/mobile/notification-payload"
import { notificationUuid, parseNotificationPreferences, restrictNotificationPreferences } from "@/shared/mobile/notification-settings"
import { notificationHistoryBody } from "@/shared/mobile/notification-history"
import { SchedulerDeadline, schedulerTransaction } from "@/lib/scheduler-deadline"

interface NativeEvent {
  id: string; household_id: string; kind: MobileNotificationKind; member_ids: string[];
  subject: Record<string, unknown>; occurred_at: Date; expires_at: Date;
}
interface Recipient {
  user_id: string; device_id: string; platform: "android" | "ios"; permission: string;
  expo_push_token: string | null; preferences: unknown; role: string; timezone: string;
  member_ids: string[]; created_at: Date; session_id: string | null;
}
export interface NativePushMessage {
  to: string; title: string; body: string; sound: "default"; priority: "high";
  channelId: string; collapseId: string; tag: string; threadId: string; ttl: number;
  data: NativeNotificationPayload;
}
export interface ClaimedNativeDelivery { id: string; leaseId: string; message: NativePushMessage }

const recipientSelect = `select d.user_id,d.device_id,d.platform,d.permission,d.expo_push_token,d.created_at,d.session_id,
  p.preferences,hm.role,h.timezone,
  array(select user_id from household_members where household_id=h.id) as member_ids
  from household_members hm join households h on h.id=hm.household_id
  join native_notification_devices d on d.user_id=hm.user_id
  left join native_notification_preferences p on p.user_id=d.user_id and p.device_id=d.device_id and p.household_id=hm.household_id
  where hm.household_id=$1 and not exists (
    select 1 from native_kiosk_sessions k where k.device_id=d.device_id and k.state='locked'
  )`

/** Stale readiness/completion alerts are suppressed; history remains in the outbox. */
async function currentEvent(client: PoolClient, event: NativeEvent): Promise<NativeEvent | null> {
  const subject = event.subject
  const taskEvent = event.kind.startsWith("task_") || event.kind.startsWith("reward_")
  const routineEvent = event.kind.startsWith("routine_")
  const primary = taskEvent || routineEvent ? subject.occurrenceId : event.household_id
  const secondary = taskEvent ? subject.taskId : routineEvent ? "" : subject.memberId
  if (typeof primary !== "string" || !notificationUuid.test(primary) || typeof secondary !== "string"
    || (taskEvent && !notificationUuid.test(secondary))) return null
  const current = (await client.query<{ state: Record<string, unknown> | null }>(
    "select native_notification_subject_state($1,$2,$3) as state",
    [taskEvent ? "task" : routineEvent ? "routine" : "member", primary, secondary],
  )).rows[0]?.state
  if (event.kind === "member_left") return current ? null : event
  if (!current || current.householdId !== event.household_id || current.status === "cancelled" || current.occurrenceStatus === "cancelled") return null
  const transition = (taskEvent && event.kind !== "task_assigned") || ["routine_completed", "routine_superseded", "routine_reopened"].includes(event.kind)
  if (transition && subject.statusVersion != null && current.statusVersion != null && subject.statusVersion !== current.statusVersion) return null
  if (taskEvent) {
    if (["task_available", "reward_available"].includes(event.kind) && (current.status !== "unlocked" || current.occurrenceStatus !== "active")) return null
    if (["task_completed", "reward_completed", "task_completed_automatically"].includes(event.kind) && current.status !== "completed") return null
    if (["task_reopened", "task_assigned"].includes(event.kind) && current.status === "completed") return null
    if (["task_available", "reward_available", "task_assigned"].includes(event.kind)) {
      const currentMembers = Array.isArray(current.memberIds) ? current.memberIds : []
      event = { ...event, member_ids: event.member_ids.filter(id => currentMembers.includes(id)) }
    }
  }
  if (["routine_completed", "routine_superseded"].includes(event.kind) && current.status !== "completed") return null
  if (event.kind === "routine_reopened" && current.status !== "active") return null
  return { ...event, subject: { ...subject, name: current.name } }
}

function eligible(event: NativeEvent, recipient: Recipient, now: Date) {
  if (!recipient.session_id || !recipient.expo_push_token || !["granted", "provisional"].includes(recipient.permission)
    || recipient.created_at > event.occurred_at || event.expires_at <= now) return null
  try {
    const role = normalizeRole(recipient.role)
    const preferences = restrictNotificationPreferences(recipient.preferences
      ? parseNotificationPreferences(recipient.preferences) : defaultNotificationPreferences(recipient.user_id, recipient.timezone || "UTC"),
    recipient.user_id, role, recipient.member_ids)
    const members = event.member_ids.filter(id => recipient.member_ids.includes(id))
    return shouldPushNotification({ kind: event.kind, memberIds: members, userId: recipient.user_id, role, preferences, now }) ? preferences : null
  } catch { return null } // Invalid stored settings fail closed, without leaking their content.
}

function messageFor(id: string, event: NativeEvent, recipient: Recipient, preferences: DeviceNotificationPreferences, now: Date): NativePushMessage {
  // Names remain outside the data payload and are omitted entirely for private alerts.
  const name = typeof event.subject.name === "string" ? event.subject.name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120) : ""
  const occurrenceId = typeof event.subject.occurrenceId === "string" ? event.subject.occurrenceId : undefined
  const taskId = typeof event.subject.taskId === "string" ? event.subject.taskId : undefined
  const details = preferences.showDetails
  return { to: recipient.expo_push_token!, title: "Cyntch", body: `${details && name ? `${name}: ` : ""}${notificationHistoryBody(event.kind, event.subject.departureReason)}`,
    sound: "default", priority: "high", channelId: `cyntch-${event.kind}`, collapseId: id, tag: id, threadId: event.household_id,
    ttl: Math.max(1, Math.floor((event.expires_at.getTime() - now.getTime()) / 1000)),
    data: { version: 3, sessionId: recipient.session_id!, deliveryId: id, accountId: recipient.user_id, householdId: event.household_id,
      hasDetails: Boolean(details && name), expiresAt: event.expires_at.getTime(),
      memberSelectionHash: notificationCatalog[event.kind].scope === "member" ? createHash("sha256").update(notificationMemberSelection(preferences, event.kind)).digest("hex") : null,
      eventId: event.id, kind: event.kind, ...(occurrenceId ? { occurrenceId } : {}), ...(taskId ? { taskId } : {}) } }
}

/** Expansion and recipient rows commit together. Competing workers skip locked events. */
export async function expandNativeNotificationEvents(pool: Pool, limit = 50, deadline = new SchedulerDeadline(25_000)) {
  return schedulerTransaction(pool, deadline, async client => {
    const rows = (await client.query<NativeEvent>(`select * from native_notification_events
      where state='pending' and next_attempt_at<=now() order by occurred_at,id limit $1 for update skip locked`,
    [Math.max(1, Math.min(100, Math.floor(limit)))])).rows
    let queued = 0
    const now = (await client.query<{ now: Date }>("select clock_timestamp() as now")).rows[0].now
    for (const event of rows) {
      const current = event.expires_at > now ? await currentEvent(client, event) : null
      if (current) {
        const recipients = (await client.query<Recipient>(recipientSelect, [event.household_id])).rows
        for (const recipient of recipients) {
          if (!eligible(current, recipient, now)) continue
          queued += (await client.query(`insert into native_notification_deliveries(event_id,user_id,device_id,session_id)
            values($1,$2,$3,$4) on conflict(event_id,user_id,device_id) do nothing`, [event.id, recipient.user_id, recipient.device_id, recipient.session_id])).rowCount ?? 0
        }
      }
      await client.query("update native_notification_events set state=$2 where id=$1", [event.id, event.expires_at <= now ? "expired" : "expanded"])
    }
    return { expanded: rows.length, queued }
  })
}

/** Call immediately before provider I/O. No network or user-write locks are held.
 * A crashed sender's lease expires; the same delivery ID is reused on its retry.
 */
export async function claimNativeNotificationDeliveries(pool: Pool, limit = 100, deadline = new SchedulerDeadline(25_000)): Promise<ClaimedNativeDelivery[]> {
  return schedulerTransaction(pool, deadline, async client => {
    const jobs = (await client.query<{ id: string; event_id: string; user_id: string; device_id: string; session_id: string | null }>(`select id,event_id,user_id,device_id,session_id
      from native_notification_deliveries where next_attempt_at<=now()
        and (state='queued' or (state='sending' and lease_until<=now()))
      order by next_attempt_at,created_at,id limit $1 for update skip locked`, [Math.max(1, Math.min(100, Math.floor(limit)))])).rows
    const claimed: ClaimedNativeDelivery[] = []
    for (const job of jobs) {
      const now = (await client.query<{ now: Date }>("select clock_timestamp() as now")).rows[0].now
      const event = (await client.query<NativeEvent>("select * from native_notification_events where id=$1", [job.event_id])).rows[0]
      const current = event && event.expires_at > now ? await currentEvent(client, event) : null
      const recipient = current ? (await client.query<Recipient>(`${recipientSelect} and d.user_id=$2 and d.device_id=$3`, [current.household_id, job.user_id, job.device_id])).rows[0] : null
      const preferences = current && recipient ? eligible(current, recipient, now) : null
      if (!current || !recipient || !preferences || job.session_id !== recipient.session_id) {
        await client.query(`update native_notification_deliveries set state=$2,completed_at=now(),lease_id=null,lease_until=null,
          last_error_code=$3 where id=$1`, [job.id, event?.expires_at <= now ? "expired" : "suppressed", event?.expires_at <= now ? "expired" : "no_longer_eligible"])
        continue
      }
      const leaseId = randomUUID()
      await client.query(`update native_notification_deliveries set state='sending',attempts=attempts+1,lease_id=$2,
        lease_until=now()+interval '60 seconds',token_hash=$3,last_error_code=null where id=$1`,
      [job.id, leaseId, createHash("sha256").update(recipient.expo_push_token!).digest("hex")])
      claimed.push({ id: job.id, leaseId, message: messageFor(job.id, current, recipient, preferences, now) })
    }
    return claimed
  })
}
