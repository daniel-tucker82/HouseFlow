import type { PoolClient } from "pg"
import { db } from "@/lib/db"
import type { EffectiveRole } from "@/lib/household-authz"
import { dispatchPushForNotificationIds } from "@/lib/push"

export type NotificationKind =
  | "task_unlocked_self"
  | "task_unlocked_other"
  | "reward_unlocked_self"
  | "reward_unlocked_other"
  | "routine_occurrence_generated"
  | "member_joined_via_link"
  | "member_left_household"

type PreferenceRow = {
  user_id: string
  task_unlocked_self_enabled: boolean
  task_unlocked_other_enabled: boolean
  reward_unlocked_self_enabled: boolean
  reward_unlocked_other_enabled: boolean
  routine_occurrence_generated_enabled: boolean
  member_joined_via_link_enabled: boolean
  member_left_household_enabled: boolean
  task_unlocked_other_member_ids: unknown
  reward_unlocked_other_member_ids: unknown
}

type HouseholdMember = {
  user_id: string
  role: string
  name: string
}

type UnlockNotificationInput = {
  householdId: string
  actorUserId: string
  occurrenceId: string
  taskId: string
  taskTitle: string
  isReward: boolean
  assigneeIds: string[]
  unlockCause: "prerequisite_completion" | "other"
  unlockAt?: string | null
  url?: string
}

function toIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item).trim()).filter(Boolean)
}

function normalizeRole(role: string): EffectiveRole {
  if (role === "manager" || role === "supervisor" || role === "member") return role
  if (role === "leader") return "manager"
  return "member"
}

async function ensureDefaultNotificationPreferences(client: PoolClient, householdId: string) {
  await client.query<{ user_id: string; role: string }>(
    `insert into notification_preferences (
       user_id,
       household_id,
       task_unlocked_self_enabled,
       task_unlocked_other_enabled,
       reward_unlocked_self_enabled,
       reward_unlocked_other_enabled,
       routine_occurrence_generated_enabled,
       member_joined_via_link_enabled,
       member_left_household_enabled
     )
     select
       hm.user_id,
       hm.household_id,
       true,
       false,
       true,
       false,
       (hm.role = 'manager'::app_role),
       (hm.role = 'manager'::app_role),
       (hm.role = 'manager'::app_role)
     from household_members hm
     where hm.household_id = $1::uuid
     on conflict (user_id, household_id) do nothing`,
    [householdId],
  )
}

function roleSupportsKind(role: EffectiveRole, kind: NotificationKind) {
  if (role === "member") return kind === "task_unlocked_self" || kind === "reward_unlocked_self"
  if (role === "supervisor") {
    return (
      kind === "task_unlocked_self" ||
      kind === "task_unlocked_other" ||
      kind === "reward_unlocked_self" ||
      kind === "reward_unlocked_other"
    )
  }
  return true
}

function prefEnabledForKind(pref: PreferenceRow, kind: NotificationKind) {
  switch (kind) {
    case "task_unlocked_self":
      return pref.task_unlocked_self_enabled
    case "task_unlocked_other":
      return pref.task_unlocked_other_enabled
    case "reward_unlocked_self":
      return pref.reward_unlocked_self_enabled
    case "reward_unlocked_other":
      return pref.reward_unlocked_other_enabled
    case "routine_occurrence_generated":
      return pref.routine_occurrence_generated_enabled
    case "member_joined_via_link":
      return pref.member_joined_via_link_enabled
    case "member_left_household":
      return pref.member_left_household_enabled
    default:
      return false
  }
}

export async function createUnlockNotifications(client: PoolClient, input: UnlockNotificationInput): Promise<string[]> {
  const createdNotificationIds: string[] = []
  await ensureDefaultNotificationPreferences(client, input.householdId)

  const eventKind: NotificationKind = input.isReward ? "reward_unlocked_self" : "task_unlocked_self"
  const unlockFingerprint = `${input.occurrenceId}:${input.taskId}:${input.unlockAt ?? "none"}:${eventKind}`
  const existingEvent = await client.query<{ id: string }>(
    `select id
     from notification_events ne
     where ne.household_id = $1::uuid
       and ne.kind = $2::notification_kind
       and ne.subject_occurrence_id = $3::uuid
       and (
         ne.subject_task_id = $4::uuid
         or ne.subject_reward_id = $4::uuid
       )
       and coalesce(ne.metadata->>'unlockFingerprint', '') = $5
     limit 1`,
    [input.householdId, eventKind, input.occurrenceId, input.taskId, unlockFingerprint],
  )
  if ((existingEvent.rowCount ?? 0) > 0) {
    return []
  }

  const eventRes = await client.query<{ id: string }>(
    `insert into notification_events (
       household_id,
       kind,
       actor_user_id,
       subject_task_id,
       subject_reward_id,
       subject_occurrence_id,
       metadata
     )
     values (
       $1::uuid,
       $2::notification_kind,
       $3,
       $4::uuid,
       $5::uuid,
       $6::uuid,
       $7::jsonb
     )
     returning id`,
    [
      input.householdId,
      eventKind,
      input.actorUserId,
      input.isReward ? null : input.taskId,
      input.isReward ? input.taskId : null,
      input.occurrenceId,
      JSON.stringify({
        taskTitle: input.taskTitle,
        assigneeIds: input.assigneeIds,
        unlockCause: input.unlockCause,
        unlockAt: input.unlockAt ?? null,
        unlockFingerprint,
        url: input.url ?? `/member/dashboard?household=${encodeURIComponent(input.householdId)}`,
      }),
    ],
  )
  const eventId = String(eventRes.rows[0]?.id ?? "")
  if (!eventId) return []

  const membersRes = await client.query<HouseholdMember>(
    `select hm.user_id, hm.role, coalesce(u.full_name, u.email, hm.user_id) as name
     from household_members hm
     left join users u on u.id = hm.user_id
     where hm.household_id = $1::uuid`,
    [input.householdId],
  )
  const prefsRes = await client.query<PreferenceRow>(
    `select user_id,
            task_unlocked_self_enabled,
            task_unlocked_other_enabled,
            reward_unlocked_self_enabled,
            reward_unlocked_other_enabled,
            routine_occurrence_generated_enabled,
            member_joined_via_link_enabled,
            member_left_household_enabled,
            task_unlocked_other_member_ids,
            reward_unlocked_other_member_ids
     from notification_preferences
     where household_id = $1::uuid`,
    [input.householdId],
  )
  const prefByUser = new Map(prefsRes.rows.map((row) => [row.user_id, row]))
  const nameByUser = new Map(membersRes.rows.map((row) => [row.user_id, row.name]))

  for (const member of membersRes.rows) {
    const recipientId = member.user_id
    const role = normalizeRole(member.role)
    const isSelf = input.assigneeIds.includes(recipientId)
    const kind: NotificationKind = input.isReward
      ? isSelf
        ? "reward_unlocked_self"
        : "reward_unlocked_other"
      : isSelf
        ? "task_unlocked_self"
        : "task_unlocked_other"
    if (!roleSupportsKind(role, kind)) continue
    const pref = prefByUser.get(recipientId)
    if (!pref || !prefEnabledForKind(pref, kind)) continue
    if (!isSelf) {
      const watchedIds = kind === "task_unlocked_other"
        ? toIdArray(pref.task_unlocked_other_member_ids)
        : toIdArray(pref.reward_unlocked_other_member_ids)
      const watchesAny = input.assigneeIds.some((assigneeId) => watchedIds.includes(assigneeId))
      if (!watchesAny) continue
    }

    const shouldSuppress =
      kind === "task_unlocked_self" &&
      recipientId === input.actorUserId &&
      input.unlockCause === "prerequisite_completion"

    const memberNames = input.assigneeIds.map((id) => nameByUser.get(id) ?? "Member").join(", ")
    const body = isSelf
      ? `${input.isReward ? "Your reward" : "Your task"}: ${input.taskTitle} is unlocked.`
      : `The ${input.isReward ? "reward" : "task"}: ${input.taskTitle} for ${memberNames} is unlocked.`
    const insertResult = await client.query<{ id: string }>(
      `insert into user_notifications (
         event_id,
         user_id,
         title,
         body,
         suppressed,
         suppressed_reason
       )
       values ($1::uuid, $2, $3, $4, $5, $6)
       returning id`,
      [
        eventId,
        recipientId,
        input.isReward ? "Reward unlocked" : "Task unlocked",
        body,
        shouldSuppress,
        shouldSuppress ? "self_prerequisite_completion" : null,
      ],
    )
    if (!shouldSuppress) {
      const notificationId = String(insertResult.rows[0]?.id ?? "")
      if (notificationId) createdNotificationIds.push(notificationId)
    }
  }
  return createdNotificationIds
}

export async function createManagerNotificationEvent(input: {
  householdId: string
  actorUserId: string | null
  kind: "routine_occurrence_generated" | "member_joined_via_link" | "member_left_household"
  title: string
  body: string
  metadata?: Record<string, unknown>
}) {
  let createdNotificationIds: string[] = []
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    createdNotificationIds = await createManagerNotificationEventInTransaction(client, input)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  await dispatchPushForNotificationIds(createdNotificationIds)
}

export async function createManagerNotificationEventInTransaction(
  client: PoolClient,
  input: {
    householdId: string
    actorUserId: string | null
    kind: "routine_occurrence_generated" | "member_joined_via_link" | "member_left_household"
    title: string
    body: string
    metadata?: Record<string, unknown>
  },
): Promise<string[]> {
  const createdNotificationIds: string[] = []
  await ensureDefaultNotificationPreferences(client, input.householdId)
  const eventRes = await client.query<{ id: string }>(
    `insert into notification_events (household_id, kind, actor_user_id, metadata)
     values ($1::uuid, $2::notification_kind, $3, $4::jsonb)
     returning id`,
    [
      input.householdId,
      input.kind,
      input.actorUserId,
      JSON.stringify({
        ...(input.metadata ?? {}),
        url:
          (input.metadata?.url as string | undefined) ??
          `/leader/dashboard?household=${encodeURIComponent(input.householdId)}`,
      }),
    ],
  )
  const eventId = String(eventRes.rows[0]?.id ?? "")
  if (!eventId) {
    return []
  }
  const recipients = await client.query<{ user_id: string }>(
    `select hm.user_id
     from household_members hm
     join notification_preferences np
       on np.user_id = hm.user_id
      and np.household_id = hm.household_id
     where hm.household_id = $1::uuid
       and hm.role = 'manager'::app_role
       and (
         ($2::notification_kind = 'routine_occurrence_generated' and np.routine_occurrence_generated_enabled)
         or ($2::notification_kind = 'member_joined_via_link' and np.member_joined_via_link_enabled)
         or ($2::notification_kind = 'member_left_household' and np.member_left_household_enabled)
       )`,
    [input.householdId, input.kind],
  )
  for (const row of recipients.rows) {
    const insertResult = await client.query<{ id: string }>(
      `insert into user_notifications (event_id, user_id, title, body)
       values ($1::uuid, $2, $3, $4)
       on conflict (event_id, user_id) do nothing
       returning id`,
      [eventId, row.user_id, input.title, input.body],
    )
    const notificationId = String(insertResult.rows[0]?.id ?? "")
    if (notificationId) createdNotificationIds.push(notificationId)
  }
  return createdNotificationIds
}
