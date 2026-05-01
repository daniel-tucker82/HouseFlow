import { redirect } from "next/navigation"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { ensureRoutineSchemaColumns } from "@/lib/schema-ensure"
import { createUnlockNotifications } from "@/lib/notifications"
import { dispatchPushForNotificationIds } from "@/lib/push"
import type { AppRole, Household, Routine, Task } from "@/lib/types"
import { ensureCurrentUserRecord } from "@/lib/user-sync"

type HouseholdMembership = {
  role: AppRole
  household: Household
}

type HouseholdMembershipRow = {
  role: AppRole
  id: string
  name: string
  leader_id: string
  timezone: string
}

export async function getCurrentUserOrRedirect() {
  const { userId } = await auth()
  if (!userId) {
    redirect("/auth/login")
  }
  await ensureCurrentUserRecord()
  return { id: userId }
}

export async function getUserHouseholds(userId: string) {
  const result = await db.query<HouseholdMembershipRow>(
    `select hm.role, h.id, h.name, h.leader_id, h.timezone
     from household_members hm
     join households h on h.id = hm.household_id
     where hm.user_id = $1
     order by h.created_at desc`,
    [userId],
  )

  return result.rows.map((row: HouseholdMembershipRow) => ({
    role: row.role as AppRole,
    household: {
      id: row.id,
      name: row.name,
      leader_id: row.leader_id,
      timezone: row.timezone,
    } as Household,
  })) as HouseholdMembership[]
}

export async function getHouseholdRoutines(householdId: string) {
  await ensureRoutineSchemaColumns()
  const result = await db.query(
    `select id, household_id, name, type, recurrence_rule, coalesce(complete_older_occurrences_on_new, false) as complete_older_occurrences_on_new
     from routines
     where household_id = $1
     order by created_at desc`,
    [householdId],
  )
  return result.rows as Routine[]
}

export async function getHouseholdTasks(
  householdId: string,
  routineId?: string,
) {
  const values: (string | null)[] = [householdId]
  let query = `select id, household_id, routine_id, routine_occurrence_id, assignee_id, title, is_reward, status, position_x, position_y, scheduled_time
               , unlock_rule, unlock_at, unlock_combiner, expiry_rule, expires_at
               , description
               from tasks
               where household_id = $1`

  query += " and routine_occurrence_id is null"

  if (routineId) {
    query += " and routine_id = $2"
    values.push(routineId)
  }

  query += " order by created_at desc"
  const result = await db.query(query, values)
  return result.rows as Task[]
}

export async function getInviteByCode(code: string) {
  const result = await db.query(
    `select id, code, household_id, expires_at, is_active, max_uses, uses_count
     from household_invites
     where code = $1
     limit 1`,
    [code],
  )

  return result.rows[0] ?? null
}

export async function getMemberVisibleTasks(userId: string, householdId: string) {
  const result = await db.query(
    `select id, household_id, routine_id, assignee_id, title, is_reward, status, position_x, position_y, scheduled_time, description
           , unlock_rule, unlock_at, unlock_combiner, expiry_rule, expires_at
     from tasks
     where household_id = $1
       and assignee_id = $2
       and status in ('unlocked', 'completed')
     order by created_at desc`,
    [householdId, userId],
  )

  return result.rows as Task[]
}

type MemberViewMember = {
  id: string
  name: string
  avatar_url: string | null
  token_color: string | null
  role: AppRole
}

type MemberViewTask = {
  id: string
  occurrence_id: string
  occurrence_title: string | null
  occurrence_kind: "routine" | "manual"
  title: string
  description: string | null
  is_reward: boolean
  status: "locked" | "unlocked" | "completed"
  assignee_ids: string[]
  created_at: string
  lock_type: "none" | "prerequisite" | "time"
  blocking_task_id: string | null
  blocking_task_title: string | null
  blocking_task_assignee_ids: string[]
  unlock_at: string | null
  expires_at: string | null
}

export type HouseholdMemberViewData = {
  leaderId: string
  members: MemberViewMember[]
  tasks: MemberViewTask[]
  kioskActive: boolean
  kioskVisibleMemberIds: string[]
  kioskEditableMemberIds: string[]
}

export async function getHouseholdMemberViewData(
  householdId: string,
  actorUserId: string,
): Promise<HouseholdMemberViewData> {
  // Recompute occurrence lock states on read so time-based unlocks flip
  // even if no write action has happened recently.
  const client = await db.connect()
  const pushNotificationIds: string[] = []
  try {
    await client.query("BEGIN")
    const beforeStatuses = await client.query<{ occurrence_id: string; task_id: string; status: "locked" | "unlocked" | "completed" }>(
      `select ot.occurrence_id, ot.task_id, ot.status
       from occurrence_tasks ot
       join routine_occurrences ro on ro.id = ot.occurrence_id
       where ro.household_id = $1
         and ro.status = 'active'`,
      [householdId],
    )
    const beforeByOccurrenceTask = new Map(
      beforeStatuses.rows.map((row) => [`${row.occurrence_id}:${row.task_id}`, row.status]),
    )

    await client.query(
      `with active_occurrences as (
         select ro.id
         from routine_occurrences ro
         where ro.household_id = $1
           and ro.status = 'active'
       ),
       lock_flags as (
         select
           ot.occurrence_id,
           ot.task_id,
           coalesce(t.unlock_combiner, 'and') as unlock_combiner,
           (t.expires_at is not null and t.expires_at <= now()) as is_expired,
           exists (
             select 1
             from task_dependencies td_any
             join occurrence_tasks src_any
               on src_any.task_id = td_any.source_task_id
              and src_any.occurrence_id = ot.occurrence_id
             where td_any.target_task_id = ot.task_id
           ) as prereq_applies,
           exists (
             select 1
             from task_dependencies td
             join occurrence_tasks src
               on src.task_id = td.source_task_id
              and src.occurrence_id = ot.occurrence_id
             where td.target_task_id = ot.task_id
               and src.status <> 'completed'::task_status
           ) as prereq_unsatisfied,
           (t.unlock_at is not null) as time_applies,
           (t.unlock_at is not null and now() < t.unlock_at) as time_unsatisfied
         from occurrence_tasks ot
         join tasks t on t.id = ot.task_id
         where ot.occurrence_id in (select id from active_occurrences)
           and ot.status <> 'completed'::task_status
       )
       update occurrence_tasks ot
       set status = case
          when lf.is_expired then 'completed'::task_status
           when (
             case
               when lf.prereq_applies and lf.time_applies and lf.unlock_combiner = 'or'
                 then lf.prereq_unsatisfied and lf.time_unsatisfied
               when lf.prereq_applies and lf.time_applies
                 then lf.prereq_unsatisfied or lf.time_unsatisfied
               when lf.prereq_applies then lf.prereq_unsatisfied
               when lf.time_applies then lf.time_unsatisfied
               else false
             end
           ) then 'locked'::task_status
           else 'unlocked'::task_status
         end,
        completed_at = case
          when lf.is_expired then coalesce(ot.completed_at, now())
          else ot.completed_at
        end,
         updated_at = now()
       from lock_flags lf
       where ot.occurrence_id = lf.occurrence_id
         and ot.task_id = lf.task_id
         and ot.status <> 'completed'::task_status`,
      [householdId],
    )

    const afterStatuses = await client.query<{ occurrence_id: string; task_id: string; status: "locked" | "unlocked" | "completed" }>(
      `select ot.occurrence_id, ot.task_id, ot.status
       from occurrence_tasks ot
       join routine_occurrences ro on ro.id = ot.occurrence_id
       where ro.household_id = $1
         and ro.status = 'active'`,
      [householdId],
    )
    const unlockedTransitions = afterStatuses.rows.filter((row) => {
      const key = `${row.occurrence_id}:${row.task_id}`
      return row.status === "unlocked" && beforeByOccurrenceTask.get(key) === "locked"
    })

    if (unlockedTransitions.length > 0) {
      const unlockedTaskIds = unlockedTransitions.map((row) => row.task_id)
      const unlockedTasks = await client.query<{
        occurrence_id: string
        id: string
        title: string
        is_reward: boolean
        assignee_ids: string[]
        unlock_at: string | null
      }>(
        `select ot.occurrence_id,
                t.id,
                t.title,
                t.is_reward,
                t.unlock_at,
                coalesce(
                  array_agg(ta.user_id) filter (where ta.user_id is not null),
                  '{}'::text[]
                ) as assignee_ids
         from occurrence_tasks ot
         join tasks t on t.id = ot.task_id
         join routine_occurrences ro on ro.id = ot.occurrence_id
         left join task_assignees ta on ta.task_id = t.id
         where t.id = any($1::uuid[])
           and ro.household_id = $2
           and ro.status = 'active'
         group by ot.occurrence_id, t.id, t.title, t.is_reward, t.unlock_at`,
        [unlockedTaskIds, householdId],
      )
      for (const unlockedTask of unlockedTasks.rows) {
        const notificationIds = await createUnlockNotifications(client, {
          householdId,
          actorUserId,
          occurrenceId: unlockedTask.occurrence_id,
          taskId: unlockedTask.id,
          taskTitle: unlockedTask.title,
          isReward: Boolean(unlockedTask.is_reward),
          assigneeIds: unlockedTask.assignee_ids ?? [],
          unlockCause: "other",
          unlockAt: unlockedTask.unlock_at,
          url: `/member/dashboard?household=${encodeURIComponent(householdId)}`,
        })
        pushNotificationIds.push(...notificationIds)
      }
    }

    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
  await dispatchPushForNotificationIds(pushNotificationIds)

  const householdResult = await db.query(
    `select id, leader_id
     from households
     where id = $1
     limit 1`,
    [householdId],
  )
  if ((householdResult.rowCount ?? 0) === 0) {
    return {
      leaderId: "",
      members: [],
      tasks: [],
      kioskActive: false,
      kioskVisibleMemberIds: [],
      kioskEditableMemberIds: [],
    }
  }

  const leaderId = String(householdResult.rows[0].leader_id)

  const membersResult = await db.query(
    `select hm.user_id as id,
            coalesce(u.full_name, u.email, hm.user_id) as name,
            u.avatar_url,
            hm.token_color,
            hm.role
     from household_members hm
     left join users u on u.id = hm.user_id
     where hm.household_id = $1
     order by name asc`,
    [householdId],
  )

  const tasksResult = await db.query(
    `select t.id,
            ot.occurrence_id,
            ro.title as occurrence_title,
            ro.kind as occurrence_kind,
            t.title,
            t.description,
            t.is_reward,
            ot.status,
            t.created_at,
            t.unlock_at,
            t.expires_at,
            coalesce(
              array_agg(ta.user_id) filter (where ta.user_id is not null),
              '{}'::text[]
            ) as assignee_ids
     from occurrence_tasks ot
     join routine_occurrences ro on ro.id = ot.occurrence_id
     join tasks t on t.id = ot.task_id
     left join task_assignees ta on ta.task_id = t.id
     where ro.household_id = $1
       and ro.status = 'active'
       and exists (
         select 1
         from occurrence_tasks ot_incomplete
         where ot_incomplete.occurrence_id = ot.occurrence_id
           and ot_incomplete.status <> 'completed'
       )
     group by t.id, ot.occurrence_id, ro.title, ro.kind, t.title, t.description, t.is_reward, ot.status, t.created_at
     order by t.created_at asc`,
    [householdId],
  )

  const dependencyResult = await db.query(
    `select ot.occurrence_id,
            td.target_task_id,
            td.source_task_id,
            src.title as source_task_title,
            coalesce(
              array_agg(distinct src_ta.user_id) filter (where src_ta.user_id is not null),
              '{}'::text[]
            ) as source_assignee_ids
     from occurrence_tasks ot
     join routine_occurrences ro on ro.id = ot.occurrence_id
     join task_dependencies td on td.target_task_id = ot.task_id
     join occurrence_tasks src_ot
       on src_ot.occurrence_id = ot.occurrence_id
      and src_ot.task_id = td.source_task_id
     join tasks src on src.id = src_ot.task_id
     left join task_assignees src_ta on src_ta.task_id = src.id
     where ro.household_id = $1
       and ro.status = 'active'
       and ot.status = 'locked'
       and src_ot.status <> 'completed'
     group by ot.occurrence_id, td.target_task_id, td.source_task_id, src.title, src.created_at
     order by src.created_at asc`,
    [householdId],
  )

  let kioskSettings:
    | {
        kiosk_active: boolean
        visible_member_ids: string[] | null
        editable_member_ids: string[] | null
      }
    | undefined
  try {
    const kioskSettingsResult = await db.query<{
      kiosk_active: boolean
      visible_member_ids: string[] | null
      editable_member_ids: string[] | null
    }>(
      `select kiosk_active, visible_member_ids, editable_member_ids
       from household_kiosk_settings
       where household_id = $1::uuid
       limit 1`,
      [householdId],
    )
    kioskSettings = kioskSettingsResult.rows[0]
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== "42P01") throw error
  }

  const blockerMap = new Map<string, { id: string; title: string; assigneeIds: string[] }>()
  for (const row of dependencyResult.rows as {
    occurrence_id: string
    target_task_id: string
    source_task_id: string
    source_task_title: string
    source_assignee_ids: string[]
  }[]) {
    const key = `${row.occurrence_id}:${row.target_task_id}`
    if (!blockerMap.has(key)) {
      blockerMap.set(key, {
        id: row.source_task_id,
        title: row.source_task_title,
        assigneeIds: row.source_assignee_ids ?? [],
      })
    }
  }

  const tasks = (tasksResult.rows as {
    id: string
    occurrence_id: string
    occurrence_title: string | null
    occurrence_kind: "routine" | "manual"
    title: string
    description: string | null
    is_reward: boolean
    status: "locked" | "unlocked" | "completed"
    assignee_ids: string[]
    created_at: string
    unlock_at: string | null
    expires_at: string | null
  }[]).map((row) => {
    const key = `${row.occurrence_id}:${row.id}`
    const blocker = blockerMap.get(key) ?? null
    const blockingTaskTitle = blocker?.title ?? null
    const lockType = row.status === "locked" ? (blockingTaskTitle ? "prerequisite" : (row.unlock_at ? "time" : "none")) : "none"
    return {
      ...row,
      lock_type: lockType,
      blocking_task_id: blocker?.id ?? null,
      blocking_task_title: blockingTaskTitle,
      blocking_task_assignee_ids: blocker?.assigneeIds ?? [],
      unlock_at: row.unlock_at,
      expires_at: row.expires_at,
    } satisfies MemberViewTask
  })

  return {
    leaderId,
    members: membersResult.rows as MemberViewMember[],
    tasks,
    kioskActive: Boolean(kioskSettings?.kiosk_active ?? false),
    kioskVisibleMemberIds: kioskSettings?.visible_member_ids ?? [],
    kioskEditableMemberIds: kioskSettings?.editable_member_ids ?? [],
  }
}
