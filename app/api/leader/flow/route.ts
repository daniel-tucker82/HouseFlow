import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import type { PoolClient } from "pg"
import { db } from "@/lib/db"
import { ensureRoutineSchemaColumns } from "@/lib/schema-ensure"
import { ensureCurrentUserRecord } from "@/lib/user-sync"
import {
  parseExpiryRule,
  parseUnlockRule,
  resolveExpiryAt,
  resolveUnlockAt,
  type UnlockCombiner,
} from "@/lib/time-rules"
import {
  createDefaultRecurrenceRule,
  latestRecurrenceAtOrBefore,
  normalizeRecurrenceRule,
  parseRoutineRecurrenceRules,
  recurrenceRuleSummary,
  serializeRoutineRecurrenceRules,
} from "@/lib/recurrence"
import {
  canEditMemberTasksInView,
  canPerformAction,
  constantTimeEqual,
  getHouseholdKioskSettings,
  getHouseholdMembershipAuthz,
  hashPin,
  sha256,
  verifyPinHash,
} from "@/lib/household-authz"
import {
  createManagerNotificationEvent,
  createManagerNotificationEventInTransaction,
  createUnlockNotifications,
} from "@/lib/notifications"
import { dispatchPushForNotificationIds } from "@/lib/push"

type QueryClient = {
  query: (...args: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
}

function readCookieValue(cookieHeader: string | null, key: string) {
  if (!cookieHeader) return null
  const segments = cookieHeader.split(";").map((segment) => segment.trim())
  for (const segment of segments) {
    if (!segment.startsWith(`${key}=`)) continue
    return decodeURIComponent(segment.slice(key.length + 1))
  }
  return null
}

async function getHouseholdTimeZone(client: QueryClient, householdId: string) {
  const result = (await client.query(
    `select timezone from households where id = $1::uuid limit 1`,
    [householdId],
  )) as { rows: Array<{ timezone?: string | null }> }
  return String(result.rows[0]?.timezone ?? "UTC")
}

async function backfillHouseholdTimeZoneIfUtc(client: QueryClient, householdId: string, clientTimeZone?: string | null) {
  const tz = (clientTimeZone ?? "").trim()
  if (!tz) return
  const currentTz = await getHouseholdTimeZone(client, householdId)
  if (currentTz.toUpperCase() !== "UTC") return
  await client.query(
    `update households
     set timezone = $1
     where id = $2::uuid`,
    [tz, householdId],
  )
}

function toFixedRuleFromInstant(
  instant: Date,
  timeZone = "UTC",
): { kind: "fixed"; date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant)
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ""
  const year = pick("year")
  const month = pick("month")
  const day = pick("day")
  const hour = pick("hour")
  const minute = pick("minute")
  return {
    kind: "fixed",
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
  }
}

function shouldMaterializeToFixedOnOccurrence(rule: { kind?: string } | null): boolean {
  const kind = String(rule?.kind ?? "")
  return (
    kind === "after_creation" ||
    kind === "after_generation_days" ||
    kind === "weekday_after_generation" ||
    kind === "month_day_after_generation"
  )
}

function isUnlockBasedDeferredExpiryRule(rule: { kind?: string } | null): boolean {
  const kind = String(rule?.kind ?? "")
  return (
    kind === "after_unlock" ||
    kind === "weekday_after_unlock" ||
    kind === "month_day_after_unlock"
  )
}

async function materializeDeferredExpiryForUnlockedTasks(client: PoolClient, occurrenceId: string) {
  const rows = await client.query<{
    id: string
    unlock_at: string | null
    created_at: string
    expiry_rule: Record<string, unknown> | null
    expires_at: string | null
    timezone: string | null
  }>(
    `select t.id, t.unlock_at, t.created_at, t.expiry_rule, t.expires_at, h.timezone
     from tasks t
     join households h on h.id = t.household_id
     join occurrence_tasks ot on ot.task_id = t.id
     where ot.occurrence_id = $1::uuid
       and ot.status = 'unlocked'
       and t.expires_at is null
       and t.expiry_rule is not null`,
    [occurrenceId],
  )

  for (const row of rows.rows) {
    const expiryRule = parseExpiryRule(row.expiry_rule)
    if (
      !expiryRule ||
      (expiryRule.kind !== "after_unlock" &&
        expiryRule.kind !== "weekday_after_unlock" &&
        expiryRule.kind !== "month_day_after_unlock")
    ) {
      continue
    }
    const unlockAt = row.unlock_at ? new Date(row.unlock_at) : new Date()
    const householdTimeZone = String(row.timezone ?? "UTC")
    const expiresAt = resolveExpiryAt({
      rule: expiryRule,
      generationAt: new Date(row.created_at),
      createdAt: new Date(row.created_at),
      unlockAt,
      timeZone: householdTimeZone,
    })
    if (!expiresAt) continue
    const fixedRule = toFixedRuleFromInstant(expiresAt, householdTimeZone)
    console.info("[api][materializeDeferredExpiryForUnlockedTasks] materialized", {
      occurrenceId,
      taskId: row.id,
      householdTimeZone,
      unlockAtIso: unlockAt.toISOString(),
      createdAtIso: new Date(row.created_at).toISOString(),
      expiryRule,
      expiresAtIso: expiresAt.toISOString(),
      fixedRule,
    })
    await client.query(
      `update tasks
       set expiry_rule = $2::jsonb,
           expires_at = $3::timestamptz,
           updated_at = now()
       where id = $1::uuid`,
      [row.id, JSON.stringify(fixedRule), expiresAt.toISOString()],
    )
  }
}

async function applyRewardAutoCompletion(client: PoolClient, occurrenceId: string) {
  const result = await client.query(
    `update occurrence_tasks ot
     set status = 'completed',
         completed_at = coalesce(ot.completed_at, now()),
         updated_at = now()
     from tasks t
     where ot.occurrence_id = $1::uuid
       and ot.task_id = t.id
       and t.expires_at is not null
       and t.expires_at <= now()
       and ot.status <> 'completed'::task_status`,
    [occurrenceId],
  )
  if ((result.rowCount ?? 0) > 0) {
    console.info("[api][applyExpiryAutoCompletion] completed-expired-tasks", {
      occurrenceId,
      rowCount: result.rowCount,
    })
  }
}

async function clearExpiredOccurrenceTaskExpiryRules(client: PoolClient, occurrenceId: string) {
  await client.query(
    `update tasks t
     set expiry_rule = null,
         expires_at = null,
         updated_at = now()
     from occurrence_tasks ot
     where ot.occurrence_id = $1::uuid
       and ot.task_id = t.id
       and ot.status = 'completed'::task_status
       and t.expires_at is not null
       and t.expires_at <= now()`,
    [occurrenceId],
  )
}

async function recomputeOccurrenceStatuses(client: PoolClient, occurrenceId: string) {
  await client.query(
    `with lock_flags as (
       select
         ot.task_id,
         coalesce(t.unlock_combiner, 'and') as unlock_combiner,
          (t.expires_at is not null and t.expires_at <= now()) as is_expired,
         exists (
           select 1
           from task_dependencies td_any
           join occurrence_tasks src_any
             on src_any.task_id = td_any.source_task_id
            and src_any.occurrence_id = $1::uuid
           where td_any.target_task_id = ot.task_id
         ) as prereq_applies,
         exists (
           select 1
           from task_dependencies td
           join occurrence_tasks src
             on src.task_id = td.source_task_id
            and src.occurrence_id = $1::uuid
           where td.target_task_id = ot.task_id
             and src.status <> 'completed'::task_status
         ) as prereq_unsatisfied,
         (t.unlock_at is not null) as time_applies,
         (t.unlock_at is not null and now() < t.unlock_at) as time_unsatisfied
       from occurrence_tasks ot
       join tasks t on t.id = ot.task_id
       where ot.occurrence_id = $1::uuid
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
     where ot.occurrence_id = $1::uuid
       and ot.task_id = lf.task_id
       and ot.status <> 'completed'::task_status`,
    [occurrenceId],
  )
  // Expiry rule is one-shot on occurrence tasks: once the expiry has completed the task,
  // remove the expiry fields so users can reopen it without instant re-completion.
  await clearExpiredOccurrenceTaskExpiryRules(client, occurrenceId)
}

async function materializeDueRecurrences(
  client: PoolClient,
  householdId: string,
  userId: string,
) {
  const createdNotificationIds: string[] = []
  const routines = await client.query<{
    id: string
    name: string
    recurrence_rule: string | null
    complete_older_occurrences_on_new: boolean
  }>(
    `select id, name, recurrence_rule, coalesce(complete_older_occurrences_on_new, false) as complete_older_occurrences_on_new
     from routines
     where household_id = $1::uuid
     for update`,
    [householdId],
  )
  const now = new Date()

  for (const routine of routines.rows) {
    const rules = parseRoutineRecurrenceRules(routine.recurrence_rule)
    let rulesChanged = false
    const nextRules = [...rules]
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i]
      const dueAt = latestRecurrenceAtOrBefore(rule, now)
      if (!dueAt) continue
      const dueIso = dueAt.toISOString()
      if (rule.lastGeneratedAt) {
        const generatedAtMs = new Date(rule.lastGeneratedAt).getTime()
        const dueAtMs = dueAt.getTime()
        if (!Number.isNaN(generatedAtMs) && generatedAtMs >= dueAtMs) continue
      }
      const existing = await client.query(
        `select id
         from routine_occurrences
         where household_id = $1::uuid
           and routine_id = $2::uuid
           and kind = 'routine'
           and title = $3
           and scheduled_for = $4::timestamptz
         limit 1`,
        [householdId, routine.id, `Recurrence - ${rule.id}`, dueIso],
      )
      if ((existing.rowCount ?? 0) > 0) {
        if (rule.lastGeneratedAt !== dueIso) {
          nextRules[i] = { ...rule, lastGeneratedAt: dueIso }
          rulesChanged = true
        }
        continue
      }

      const occurrenceInsert = await client.query(
        `insert into routine_occurrences (routine_id, household_id, kind, title, scheduled_for, status, created_by)
         values ($1::uuid, $2::uuid, 'routine', $3, $4::timestamptz, 'active', $5)
         returning id`,
        [routine.id, householdId, `Recurrence - ${rule.id}`, dueIso, userId],
      )
      const newOccurrenceId = String(occurrenceInsert.rows[0]?.id ?? "")
      if (!newOccurrenceId) continue

      const templatesRes = await client.query<{
        id: string
        household_id: string
        routine_id: string
        assignee_id: string | null
        title: string
        description: string | null
        is_reward: boolean
        position_x: number | null
        position_y: number | null
        scheduled_time: string | null
        unlock_rule: Record<string, unknown> | null
        unlock_at: string | null
        unlock_combiner: UnlockCombiner
        expiry_rule: Record<string, unknown> | null
        expires_at: string | null
        created_at: string
      }>(
        `select id,
                household_id,
                routine_id,
                assignee_id,
                title,
                description,
                is_reward,
                position_x,
                position_y,
                scheduled_time,
                unlock_rule,
                unlock_at,
                unlock_combiner,
                expiry_rule,
                expires_at,
                created_at
         from tasks
         where routine_id = $1::uuid
           and household_id = $2::uuid
           and routine_occurrence_id is null
         order by created_at asc`,
        [routine.id, householdId],
      )
      const templates = templatesRes.rows
      const idMap = new Map<string, string>()
      const householdTimeZone = await getHouseholdTimeZone(client, householdId)
      const generationAt = dueAt

      for (const t of templates) {
        const unlockRule = parseUnlockRule(t.unlock_rule)
        const expiryRule = parseExpiryRule(t.expiry_rule)
        const resolvedUnlockAt = resolveUnlockAt(unlockRule, generationAt, householdTimeZone)
        const shouldDeferUnlockBasedExpiry = isUnlockBasedDeferredExpiryRule(expiryRule)
        const resolvedExpiryAt = resolveExpiryAt({
          rule: expiryRule,
          generationAt,
          createdAt: generationAt,
          unlockAt: shouldDeferUnlockBasedExpiry ? null : resolvedUnlockAt,
          timeZone: householdTimeZone,
        })
        const materializedExpiryRule =
          shouldMaterializeToFixedOnOccurrence(expiryRule) && resolvedExpiryAt
            ? toFixedRuleFromInstant(resolvedExpiryAt, householdTimeZone)
            : expiryRule
        const ins = await client.query(
          `insert into tasks (
             household_id,
             routine_id,
             routine_occurrence_id,
             assignee_id,
             title,
             description,
             is_reward,
             status,
             position_x,
             position_y,
             scheduled_time,
             unlock_rule,
             unlock_at,
             unlock_combiner,
             expiry_rule,
             expires_at,
             created_by
           )
           values ($1, $2, $3, $4, $5, $6, $7, 'locked', $8, $9, $10, $11::jsonb, $12::timestamptz, $13, $14::jsonb, $15::timestamptz, $16)
           returning id`,
          [
            t.household_id,
            t.routine_id,
            newOccurrenceId,
            t.assignee_id,
            t.title,
            t.description,
            t.is_reward,
            t.position_x,
            t.position_y,
            t.scheduled_time,
            unlockRule && unlockRule.kind !== "none" ? JSON.stringify(unlockRule) : null,
            resolvedUnlockAt ? resolvedUnlockAt.toISOString() : null,
            t.unlock_combiner ?? "and",
            materializedExpiryRule && materializedExpiryRule.kind !== "none"
              ? JSON.stringify(materializedExpiryRule)
              : null,
            resolvedExpiryAt ? resolvedExpiryAt.toISOString() : null,
            userId,
          ],
        )
        idMap.set(t.id, String(ins.rows[0]?.id ?? ""))
      }

      if (templates.length > 0) {
        const templateIds = templates.map((row) => row.id)
        const depsRes = await client.query<{ source_task_id: string; target_task_id: string }>(
          `select source_task_id, target_task_id
           from task_dependencies
           where source_task_id = any($1::uuid[])
             and target_task_id = any($1::uuid[])`,
          [templateIds],
        )
        for (const row of depsRes.rows) {
          const sourceId = idMap.get(row.source_task_id)
          const targetId = idMap.get(row.target_task_id)
          if (!sourceId || !targetId) continue
          await client.query(
            `insert into task_dependencies (source_task_id, target_task_id)
             values ($1::uuid, $2::uuid)
             on conflict (source_task_id, target_task_id) do nothing`,
            [sourceId, targetId],
          )
        }

        const assigneesRes = await client.query<{ task_id: string; user_id: string }>(
          `select task_id, user_id from task_assignees where task_id = any($1::uuid[])`,
          [templateIds],
        )
        for (const row of assigneesRes.rows) {
          const newTaskId = idMap.get(row.task_id)
          if (!newTaskId) continue
          await client.query(
            `insert into task_assignees (task_id, user_id)
             values ($1::uuid, $2)
             on conflict (task_id, user_id) do nothing`,
            [newTaskId, row.user_id],
          )
        }
      }

      await client.query(
        `insert into occurrence_tasks (occurrence_id, task_id, status)
         select $1::uuid, nt.id, 'locked'::task_status
         from tasks nt
         where nt.routine_occurrence_id = $1::uuid`,
        [newOccurrenceId],
      )
      if (routine.complete_older_occurrences_on_new) {
        await completeOlderRoutineOccurrences(client, routine.id, newOccurrenceId)
      }
      await recomputeOccurrenceStatuses(client, newOccurrenceId)
      await materializeDeferredExpiryForUnlockedTasks(client, newOccurrenceId)
      await applyRewardAutoCompletion(client, newOccurrenceId)
      const managerNotificationIds = await createManagerNotificationEventInTransaction(client, {
        householdId,
        actorUserId: userId,
        kind: "routine_occurrence_generated",
        title: "Routine occurrence generated",
        body: `An occurrence of the routine: ${routine.name} has been generated.`,
        metadata: {
          routineId: routine.id,
          routineName: routine.name,
          occurrenceId: newOccurrenceId,
          url: `/leader/dashboard?household=${encodeURIComponent(householdId)}&routine=${encodeURIComponent(routine.id)}&occurrence=${encodeURIComponent(newOccurrenceId)}`,
        },
      })
      createdNotificationIds.push(...managerNotificationIds)
      nextRules[i] = { ...rule, lastGeneratedAt: dueIso }
      rulesChanged = true

      console.info("[api][materializeDueRecurrences] created occurrence", {
        householdId,
        routineId: routine.id,
        ruleId: rule.id,
        summary: recurrenceRuleSummary(rule),
        dueAtIso: dueIso,
        occurrenceId: newOccurrenceId,
      })
    }
    if (rulesChanged) {
      await client.query(
        `update routines
         set recurrence_rule = $1,
             updated_at = now()
         where id = $2::uuid`,
        [serializeRoutineRecurrenceRules(nextRules), routine.id],
      )
    }
  }
  return createdNotificationIds
}

async function completeOlderRoutineOccurrences(
  client: PoolClient,
  routineId: string,
  newOccurrenceId: string,
) {
  const occurrence = await client.query<{ scheduled_for: string | Date }>(
    `select scheduled_for
     from routine_occurrences
     where id = $1::uuid
       and routine_id = $2::uuid
     limit 1`,
    [newOccurrenceId, routineId],
  )
  if ((occurrence.rowCount ?? 0) === 0) return
  const scheduledForRaw = occurrence.rows[0]?.scheduled_for
  if (!scheduledForRaw) return
  const scheduledFor =
    scheduledForRaw instanceof Date
      ? scheduledForRaw.toISOString()
      : new Date(String(scheduledForRaw)).toISOString()
  if (!scheduledFor || Number.isNaN(new Date(scheduledFor).getTime())) return

  await client.query(
    `update occurrence_tasks ot
     set status = 'completed'::task_status,
         completed_at = coalesce(ot.completed_at, now()),
         updated_at = now()
     where ot.occurrence_id in (
       select ro.id
       from routine_occurrences ro
       where ro.routine_id = $1::uuid
         and ro.id <> $2::uuid
         and ro.scheduled_for < $3::timestamptz
     )
       and ot.status <> 'completed'::task_status`,
    [routineId, newOccurrenceId, scheduledFor],
  )
  await client.query(
    `update routine_occurrences ro
     set status = 'completed'::occurrence_status,
         updated_at = now()
     where ro.routine_id = $1::uuid
       and ro.id <> $2::uuid
       and ro.scheduled_for < $3::timestamptz`,
    [routineId, newOccurrenceId, scheduledFor],
  )
}

export async function GET(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()
  await ensureRoutineSchemaColumns()

  const { searchParams } = new URL(request.url)
  const householdId = searchParams.get("householdId")
  const routineId = searchParams.get("routineId")
  const occurrenceId = searchParams.get("occurrenceId")
  const clientTimeZone = searchParams.get("timezone")

  if (!householdId) {
    return NextResponse.json({ error: "householdId is required" }, { status: 400 })
  }

  const memberAccess = await db.query(
    `select 1 from household_members where household_id = $1 and user_id = $2 limit 1`,
    [householdId, userId],
  )
  if ((memberAccess.rowCount ?? 0) === 0) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  await backfillHouseholdTimeZoneIfUtc(db, householdId, clientTimeZone)

  {
    const client = await db.connect()
    const pushNotificationIds: string[] = []
    try {
      await client.query("BEGIN")
      pushNotificationIds.push(...(await materializeDueRecurrences(client, householdId, userId)))
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
    await dispatchPushForNotificationIds(pushNotificationIds)
  }

  const routinesResult = await db.query(
    `select id, household_id, name, type, recurrence_rule, coalesce(complete_older_occurrences_on_new, false) as complete_older_occurrences_on_new
     from routines
     where household_id = $1
     order by created_at desc`,
    [householdId],
  )

  if (occurrenceId) {
    const occAccess = await db.query(
      `select ro.id
       from routine_occurrences ro
       where ro.id = $1::uuid
         and ro.household_id = $2`,
      [occurrenceId, householdId],
    )
    if ((occAccess.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Occurrence not found" }, { status: 404 })
    }
  }

  if (occurrenceId) {
    const client = await db.connect()
    const pushNotificationIds: string[] = []
    try {
      await client.query("BEGIN")
      const beforeStatuses = await client.query<{ task_id: string; status: "locked" | "unlocked" | "completed" }>(
        `select task_id, status
         from occurrence_tasks
         where occurrence_id = $1::uuid`,
        [occurrenceId],
      )
      const beforeByTaskId = new Map(beforeStatuses.rows.map((row) => [row.task_id, row.status]))
      await recomputeOccurrenceStatuses(client, occurrenceId)
      await materializeDeferredExpiryForUnlockedTasks(client, occurrenceId)
      await applyRewardAutoCompletion(client, occurrenceId)
      await recomputeOccurrenceStatuses(client, occurrenceId)

      const afterStatuses = await client.query<{ task_id: string; status: "locked" | "unlocked" | "completed" }>(
        `select task_id, status
         from occurrence_tasks
         where occurrence_id = $1::uuid`,
        [occurrenceId],
      )
      const unlockedTaskIds = afterStatuses.rows
        .filter((row) => row.status === "unlocked" && beforeByTaskId.get(row.task_id) === "locked")
        .map((row) => row.task_id)

      if (unlockedTaskIds.length > 0) {
        const unlockedTasks = await client.query<{
          id: string
          title: string
          is_reward: boolean
          assignee_ids: string[]
          unlock_at: string | null
        }>(
          `select t.id,
                  t.title,
                  t.is_reward,
                  t.unlock_at,
                  coalesce(
                    array_agg(ta.user_id) filter (where ta.user_id is not null),
                    '{}'::text[]
                  ) as assignee_ids
           from tasks t
           left join task_assignees ta on ta.task_id = t.id
           where t.id = any($1::uuid[])
           group by t.id, t.title, t.is_reward, t.unlock_at`,
          [unlockedTaskIds],
        )
        for (const unlockedTask of unlockedTasks.rows) {
          const notificationIds = await createUnlockNotifications(client, {
            householdId,
            actorUserId: userId,
            occurrenceId,
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
      await dispatchPushForNotificationIds(pushNotificationIds)
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  const tasksResult = occurrenceId
    ? await db.query(
        `select t.id,
                t.household_id,
                t.routine_id,
                t.routine_occurrence_id,
                t.assignee_id,
                t.title,
                t.description,
                t.is_reward,
                t.status,
                t.position_x,
                t.position_y,
                t.scheduled_time,
                t.unlock_rule,
                t.unlock_at,
                t.unlock_combiner,
                t.expiry_rule,
                t.expires_at
         from tasks t
         join occurrence_tasks ot on ot.task_id = t.id
         where ot.occurrence_id = $1::uuid
           and t.household_id = $2
         order by t.created_at asc`,
        [occurrenceId, householdId],
      )
    : await db.query(
        `select id,
                household_id,
                routine_id,
                routine_occurrence_id,
                assignee_id,
                title,
                description,
                is_reward,
                status,
                position_x,
                position_y,
                scheduled_time,
                unlock_rule,
                unlock_at,
                unlock_combiner,
                expiry_rule,
                expires_at
         from tasks
         where household_id = $1
           and routine_occurrence_id is null
           and ($2::uuid is null or routine_id = $2::uuid)
         order by created_at asc`,
        [householdId, routineId || null],
      )

  const allTasksResult = await db.query(
    `select id, routine_id, title, is_reward
     from tasks
     where household_id = $1
       and routine_occurrence_id is null
     order by created_at asc`,
    [householdId],
  )

  const depsResult = occurrenceId
    ? await db.query(
        `select td.source_task_id, td.target_task_id
         from task_dependencies td
         where exists (
                 select 1
                 from occurrence_tasks ot
                 where ot.occurrence_id = $1::uuid
                   and ot.task_id = td.source_task_id
               )
           and exists (
                 select 1
                 from occurrence_tasks ot2
                 where ot2.occurrence_id = $1::uuid
                   and ot2.task_id = td.target_task_id
               )`,
        [occurrenceId],
      )
    : await db.query(
        `select td.source_task_id, td.target_task_id
         from task_dependencies td
         join tasks src on src.id = td.source_task_id
         join tasks tgt on tgt.id = td.target_task_id
         where src.household_id = $1
           and src.routine_occurrence_id is null
           and tgt.routine_occurrence_id is null
           and ($2::uuid is null or (src.routine_id = $2::uuid and tgt.routine_id = $2::uuid))`,
        [householdId, routineId || null],
      )

  const membersResult = await db.query(
    `select hm.user_id as id,
            coalesce(u.full_name, u.email, hm.user_id) as name,
            u.avatar_url,
            hm.token_color,
            hm.role,
            (u.email is not null or hm.user_id like 'user_%') as is_clerk_linked
     from household_members hm
     left join users u on u.id = hm.user_id
     where hm.household_id = $1
     order by name asc`,
    [householdId],
  )
  const taskAssigneesResult = occurrenceId
    ? await db.query(
        `select ta.task_id, ta.user_id
         from task_assignees ta
         join occurrence_tasks ot on ot.task_id = ta.task_id
         where ot.occurrence_id = $1::uuid`,
        [occurrenceId],
      )
    : await db.query(
        `select ta.task_id, ta.user_id
         from task_assignees ta
         join tasks t on t.id = ta.task_id
         where t.household_id = $1
           and t.routine_occurrence_id is null`,
        [householdId],
      )
  const templateTaskAssigneesResult = occurrenceId
    ? await db.query(
        `select ta.task_id, ta.user_id
         from task_assignees ta
         join tasks t on t.id = ta.task_id
         where t.household_id = $1
          and t.routine_occurrence_id is null`,
        [householdId],
      )
    : taskAssigneesResult
  const invitesResult = await db.query(
    `select id, code, expires_at, max_uses, uses_count, is_active, created_at
     from household_invites
     where household_id = $1
     order by created_at desc`,
    [householdId],
  )
  const occurrencesResult = await db.query(
    `select ro.id,
            ro.routine_id,
            ro.household_id,
            ro.kind,
            ro.title,
            ro.scheduled_for,
            ro.status,
            ro.created_at,
            count(ot.task_id)::int as total_tasks,
            count(*) filter (where ot.status = 'completed')::int as completed_tasks
     from routine_occurrences ro
     left join occurrence_tasks ot on ot.occurrence_id = ro.id
     where ro.household_id = $1
     group by ro.id, ro.routine_id, ro.household_id, ro.kind, ro.title, ro.scheduled_for, ro.status, ro.created_at
     order by ro.scheduled_for desc`,
    [householdId],
  )
  const occurrenceTaskStatusesResult = occurrenceId
    ? await db.query(
        `select task_id, status
         from occurrence_tasks
         where occurrence_id = $1`,
        [occurrenceId],
      )
    : { rows: [] }
  const serverNowResult = await db.query(`select now() as server_now`)
  const serverNow = String(serverNowResult.rows[0]?.server_now ?? new Date().toISOString())

  return NextResponse.json({
    routines: routinesResult.rows,
    tasks: tasksResult.rows,
    allTasks: allTasksResult.rows,
    dependencies: depsResult.rows,
    members: membersResult.rows,
    invites: invitesResult.rows,
    occurrences: occurrencesResult.rows,
    occurrenceTaskStatuses: occurrenceTaskStatusesResult.rows,
    taskAssignees: taskAssigneesResult.rows,
    templateTaskAssignees: templateTaskAssigneesResult.rows,
    serverNow,
  })
}

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()
  await ensureRoutineSchemaColumns()

  const body = await request.json()
  const action = body?.action as string | undefined
  const clientTimeZone = String(body?.timezone ?? "").trim() || null

  if (!action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 })
  }

  if (action === "createHousehold") {
    const name = String(body?.name ?? "").trim()
    const timezone = String(body?.timezone ?? "UTC").trim() || "UTC"
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 })

    const create = await db.query(
      `insert into households (name, leader_id, timezone)
       values ($1, $2, $3)
       returning id, name, timezone`,
      [name, userId, timezone],
    )
    const householdId = create.rows[0].id
    await db.query(
      `insert into household_members (household_id, user_id, role)
       values ($1, $2, 'manager')
       on conflict (household_id, user_id)
       do update set role = excluded.role`,
      [householdId, userId],
    )
    return NextResponse.json({ household: create.rows[0] })
  }

  const householdId = String(body?.householdId ?? "")
  if (!householdId) {
    return NextResponse.json({ error: "householdId is required" }, { status: 400 })
  }

  const membership = await getHouseholdMembershipAuthz(householdId, userId)
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  if (!canPerformAction(membership.role, action)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  await backfillHouseholdTimeZoneIfUtc(db, householdId, clientTimeZone)
  const cookieValue = readCookieValue(request.headers.get("cookie"), "houseflow_kiosk_session")
  const [cookieHouseholdId, cookieToken] = (cookieValue ?? "").split(":", 2)
  const kioskSettings = await getHouseholdKioskSettings(householdId)
  const kioskSessionActive =
    kioskSettings.kioskActive &&
    cookieHouseholdId === householdId &&
    Boolean(cookieToken) &&
    Boolean(kioskSettings.sessionTokenHash) &&
    constantTimeEqual(kioskSettings.sessionTokenHash ?? "", sha256(cookieToken ?? ""))
  const kioskAllowedActions = new Set(["setOccurrenceTaskCompleted", "verifyKioskExitPin", "forgotKioskPinAndSignOut"])
  if (kioskSessionActive && !kioskAllowedActions.has(action)) {
    return NextResponse.json({ error: "Kiosk mode is active." }, { status: 423 })
  }

  if (action === "updateKioskSettings") {
    const visibleMemberIds = Array.isArray(body?.visibleMemberIds)
      ? body.visibleMemberIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const editableMemberIds = Array.isArray(body?.editableMemberIds)
      ? body.editableMemberIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const uniqueVisibleIds = [...new Set(visibleMemberIds)]
    const visibleSet = new Set(uniqueVisibleIds)
    const uniqueEditableIds = [...new Set(editableMemberIds)].filter((id) => visibleSet.has(id))

    await db.query(
      `insert into household_kiosk_settings (household_id, visible_member_ids, editable_member_ids, updated_by, updated_at)
       values ($1::uuid, $2::text[], $3::text[], $4, now())
       on conflict (household_id)
       do update set visible_member_ids = excluded.visible_member_ids,
                     editable_member_ids = excluded.editable_member_ids,
                     updated_by = excluded.updated_by,
                     updated_at = now()`,
      [householdId, uniqueVisibleIds, uniqueEditableIds, userId],
    )
    return NextResponse.json({ ok: true })
  }

  if (action === "activateKioskMode") {
    const pin = String(body?.pin ?? "").trim()
    if (pin.length < 4) {
      return NextResponse.json({ error: "PIN must be at least 4 characters." }, { status: 400 })
    }
    const requestedVisibleIds = Array.isArray(body?.visibleMemberIds)
      ? body.visibleMemberIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const requestedEditableIds = Array.isArray(body?.editableMemberIds)
      ? body.editableMemberIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const uniqueVisibleIds = [...new Set(requestedVisibleIds)]
    const visibleSet = new Set(uniqueVisibleIds)
    const uniqueEditableIds = [...new Set(requestedEditableIds)].filter((id) => visibleSet.has(id))

    const sessionToken = crypto.randomUUID()
    const pinHash = hashPin(pin)
    const sessionTokenHash = sha256(sessionToken)
    await db.query(
      `insert into household_kiosk_settings (
          household_id, visible_member_ids, editable_member_ids, kiosk_active, pin_hash, session_token_hash, updated_by, updated_at
        )
       values ($1::uuid, $2::text[], $3::text[], true, $4, $5, $6, now())
       on conflict (household_id)
       do update set visible_member_ids = excluded.visible_member_ids,
                     editable_member_ids = excluded.editable_member_ids,
                     kiosk_active = true,
                     pin_hash = excluded.pin_hash,
                     session_token_hash = excluded.session_token_hash,
                     updated_by = excluded.updated_by,
                     updated_at = now()`,
      [householdId, uniqueVisibleIds, uniqueEditableIds, pinHash, sessionTokenHash, userId],
    )

    const response = NextResponse.json({ ok: true })
    response.cookies.set("houseflow_kiosk_session", `${householdId}:${sessionToken}`, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    })
    return response
  }

  if (action === "verifyKioskExitPin") {
    const pin = String(body?.pin ?? "").trim()
    if (!pin) return NextResponse.json({ error: "PIN is required." }, { status: 400 })
    const settings = kioskSettings
    const cookieMatchesSession =
      cookieHouseholdId === householdId &&
      Boolean(cookieToken) &&
      Boolean(settings.sessionTokenHash) &&
      constantTimeEqual(settings.sessionTokenHash ?? "", sha256(cookieToken ?? ""))

    if (!settings.kioskActive || !settings.pinHash || !cookieMatchesSession) {
      return NextResponse.json({ error: "Kiosk session not active." }, { status: 400 })
    }
    const pinMatches = verifyPinHash(settings.pinHash, pin)
    if (!pinMatches) {
      return NextResponse.json({ error: "Incorrect PIN." }, { status: 401 })
    }

    await db.query(
      `update household_kiosk_settings
       set kiosk_active = false,
           session_token_hash = null,
           updated_by = $2,
           updated_at = now()
       where household_id = $1::uuid`,
      [householdId, userId],
    )
    const response = NextResponse.json({ ok: true })
    response.cookies.delete("houseflow_kiosk_session")
    return response
  }

  if (action === "forgotKioskPinAndSignOut") {
    await db.query(
      `update household_kiosk_settings
       set kiosk_active = false,
           pin_hash = null,
           session_token_hash = null,
           updated_by = $2,
           updated_at = now()
       where household_id = $1::uuid`,
      [householdId, userId],
    )
    const response = NextResponse.json({ ok: true, shouldSignOut: true })
    response.cookies.delete("houseflow_kiosk_session")
    return response
  }

  if (action === "createRoutine") {
    const name = String(body?.name ?? "").trim() || "New routine"
    const type = body?.type === "one_off" ? "one_off" : "recurring"
    const recurrenceRule = String(body?.recurrenceRule ?? "").trim() || null
    const result = await db.query(
      `insert into routines (household_id, name, type, recurrence_rule, complete_older_occurrences_on_new, created_by)
       values ($1, $2, $3, $4, $5, $6)
       returning id, household_id, name, type, recurrence_rule, complete_older_occurrences_on_new`,
      [householdId, name, type, recurrenceRule, false, userId],
    )
    return NextResponse.json({ routine: result.rows[0] })
  }

  if (action === "renameRoutine") {
    const routineId = String(body?.routineId ?? "").trim()
    const name = String(body?.name ?? "").trim()
    if (!routineId || !name) {
      return NextResponse.json({ error: "routineId and name are required" }, { status: 400 })
    }
    const result = await db.query(
      `update routines
       set name = $1,
           updated_at = now()
       where id = $2::uuid
         and household_id = $3
       returning id, household_id, name, type, recurrence_rule, complete_older_occurrences_on_new`,
      [name, routineId, householdId],
    )
    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Routine not found" }, { status: 404 })
    }
    return NextResponse.json({ routine: result.rows[0] })
  }

  if (action === "createInvite") {
    const code = crypto.randomUUID().replaceAll("-", "").slice(0, 12)
    const maxUses = Number(body?.maxUses ?? 10)
    const expiresInDays = Number(body?.expiresInDays ?? 30)
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()

    const result = await db.query(
      `insert into household_invites (household_id, created_by, code, expires_at, max_uses)
       values ($1, $2, $3, $4, $5)
       returning id, code, expires_at, max_uses, uses_count, is_active, created_at`,
      [householdId, userId, code, expiresAt, maxUses],
    )
    return NextResponse.json({ invite: result.rows[0] })
  }

  if (action === "deactivateInvite") {
    const inviteId = String(body?.inviteId ?? "").trim()
    if (!inviteId) {
      return NextResponse.json({ error: "inviteId is required" }, { status: 400 })
    }
    const result = await db.query(
      `update household_invites
       set is_active = false,
           updated_at = now()
       where id = $1::uuid
         and household_id = $2::uuid
       returning id, is_active`,
      [inviteId, householdId],
    )
    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Invite not found" }, { status: 404 })
    }
    return NextResponse.json({ ok: true, invite: result.rows[0] })
  }

  if (action === "createHouseholdMember") {
    const name = String(body?.name ?? "").trim()
    const tokenColor = String(body?.tokenColor ?? "").trim() || null
    const requestedRole = String(body?.role ?? "").trim()
    const role = requestedRole === "supervisor" ? "supervisor" : "member"
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 })
    }

    const memberUserId = `local_member_${crypto.randomUUID()}`
    const client = await db.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        `insert into users (id, full_name, email, avatar_url)
         values ($1, $2, null, null)`,
        [memberUserId, name],
      )
      const memberResult = await client.query(
        `insert into household_members (household_id, user_id, role, token_color)
         values ($1::uuid, $2, $3::app_role, $4)
         returning user_id as id, role, token_color`,
        [householdId, memberUserId, role, tokenColor],
      )
      await client.query("COMMIT")
      return NextResponse.json({
        ok: true,
        member: {
          ...memberResult.rows[0],
          name,
          avatar_url: null,
          is_clerk_linked: false,
        },
      })
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  if (action === "updateMemberTokenColor") {
    const memberUserId = String(body?.memberUserId ?? "").trim()
    const tokenColor = String(body?.tokenColor ?? "").trim() || null
    if (!memberUserId) {
      return NextResponse.json({ error: "memberUserId is required" }, { status: 400 })
    }
    await db.query(
      `update household_members
       set token_color = $1
       where household_id = $2
         and user_id = $3`,
      [tokenColor, householdId, memberUserId],
    )
    return NextResponse.json({ ok: true })
  }

  if (action === "updateMemberRole") {
    const memberUserId = String(body?.memberUserId ?? "").trim()
    const requestedRole = String(body?.role ?? "").trim()
    const role = requestedRole === "supervisor" ? "supervisor" : "member"
    if (!memberUserId) {
      return NextResponse.json({ error: "memberUserId is required" }, { status: 400 })
    }
    if (memberUserId === membership.leaderId) {
      return NextResponse.json({ error: "Household manager role cannot be changed here." }, { status: 400 })
    }

    const result = await db.query(
      `update household_members
       set role = $1::app_role
       where household_id = $2::uuid
         and user_id = $3
       returning user_id, role`,
      [role, householdId, memberUserId],
    )
    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Member not found." }, { status: 404 })
    }
    return NextResponse.json({ ok: true, member: result.rows[0] })
  }

  if (action === "removeHouseholdMember") {
    const memberUserId = String(body?.memberUserId ?? "").trim()
    if (!memberUserId) {
      return NextResponse.json({ error: "memberUserId is required" }, { status: 400 })
    }
    if (memberUserId === membership.leaderId) {
      return NextResponse.json({ error: "Household manager cannot be removed." }, { status: 400 })
    }

    const memberInfo = await db.query<{ member_name: string; household_name: string }>(
      `select
          coalesce(u.full_name, u.email, hm.user_id) as member_name,
          h.name as household_name
       from household_members hm
       join households h on h.id = hm.household_id
       left join users u on u.id = hm.user_id
       where hm.household_id = $1::uuid
         and hm.user_id = $2
       limit 1`,
      [householdId, memberUserId],
    )
    if ((memberInfo.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Member not found." }, { status: 404 })
    }

    const deleteResult = await db.query(
      `delete from household_members
       where household_id = $1::uuid
         and user_id = $2`,
      [householdId, memberUserId],
    )
    if ((deleteResult.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Member not found." }, { status: 404 })
    }

    const memberName = String(memberInfo.rows[0]?.member_name ?? "A household member")
    const householdName = String(memberInfo.rows[0]?.household_name ?? "household")
    await createManagerNotificationEvent({
      householdId,
      actorUserId: userId,
      kind: "member_left_household",
      title: "Household member left",
      body: `${memberName} has left your ${householdName} household.`,
      metadata: {
        memberName,
        householdName,
        url: `/leader/dashboard?household=${encodeURIComponent(householdId)}`,
      },
    })
    return NextResponse.json({ ok: true })
  }

  if (action === "renameHouseholdMember") {
    const memberUserId = String(body?.memberUserId ?? "").trim()
    const name = String(body?.name ?? "").trim()
    if (!memberUserId || !name) {
      return NextResponse.json({ error: "memberUserId and name are required" }, { status: 400 })
    }

    const linkedResult = await db.query<{ is_clerk_linked: boolean }>(
      `select (u.email is not null or u.id like 'user_%') as is_clerk_linked
       from users u
       join household_members hm on hm.user_id = u.id
       where hm.household_id = $1::uuid
         and hm.user_id = $2
       limit 1`,
      [householdId, memberUserId],
    )
    if ((linkedResult.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Member not found." }, { status: 404 })
    }
    if (Boolean(linkedResult.rows[0]?.is_clerk_linked)) {
      return NextResponse.json({ error: "Clerk-linked members must update their name in Clerk profile settings." }, { status: 400 })
    }

    await db.query(
      `update users
       set full_name = $1,
           updated_at = now()
       where id = $2`,
      [name, memberUserId],
    )
    return NextResponse.json({ ok: true })
  }

  if (action === "updateRoutineRecurrenceSettings") {
    const routineId = String(body?.routineId ?? "").trim()
    const completeOlderOccurrencesOnNew = Boolean(body?.completeOlderOccurrencesOnNew)
    if (!routineId) {
      return NextResponse.json({ error: "routineId is required" }, { status: 400 })
    }
    const result = await db.query(
      `update routines
       set complete_older_occurrences_on_new = $1,
           updated_at = now()
       where id = $2::uuid
         and household_id = $3::uuid
       returning id, household_id, name, type, recurrence_rule, complete_older_occurrences_on_new`,
      [completeOlderOccurrencesOnNew, routineId, householdId],
    )
    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Routine not found" }, { status: 404 })
    }
    return NextResponse.json({ routine: result.rows[0] })
  }

  if (action === "createOccurrence") {
    const routineId = String(body?.routineId ?? "")
    const scheduledFor = String(body?.scheduledFor ?? new Date().toISOString())
    const clientTimeZone = String(body?.timezone ?? "").trim()
    if (!routineId) {
      return NextResponse.json({ error: "routineId is required" }, { status: 400 })
    }

    const client = await db.connect()
    try {
      await client.query("BEGIN")

      const routineCheck = await client.query<{ id: string; complete_older_occurrences_on_new: boolean }>(
        `select id, coalesce(complete_older_occurrences_on_new, false) as complete_older_occurrences_on_new
         from routines where id = $1 and household_id = $2 limit 1`,
        [routineId, householdId],
      )
      if ((routineCheck.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK")
        return NextResponse.json({ error: "Routine not found" }, { status: 404 })
      }

      const occurrenceInsert = await client.query(
        `insert into routine_occurrences (routine_id, household_id, kind, scheduled_for, status, created_by)
         values ($1, $2, 'routine', $3::timestamptz, 'active', $4)
         returning id, routine_id, household_id, kind, title, scheduled_for, status`,
        [routineId, householdId, scheduledFor, userId],
      )
      const occurrence = occurrenceInsert.rows[0] as { id: string }
      const newOccurrenceId = occurrence.id
      await backfillHouseholdTimeZoneIfUtc(client, householdId, clientTimeZone)
      const householdTimeZone = await getHouseholdTimeZone(client, householdId)

      const templatesRes = await client.query(
        `select id,
                household_id,
                routine_id,
                assignee_id,
                title,
                description,
                is_reward,
                position_x,
                position_y,
                scheduled_time,
                unlock_rule,
                unlock_at,
                unlock_combiner,
                expiry_rule,
                expires_at,
                created_at
         from tasks
         where routine_id = $1
           and household_id = $2
           and routine_occurrence_id is null
         order by created_at asc`,
        [routineId, householdId],
      )
      const templates = templatesRes.rows as Array<{
        id: string
        household_id: string
        routine_id: string
        assignee_id: string | null
        title: string
        description: string | null
        is_reward: boolean
        position_x: number | null
        position_y: number | null
        scheduled_time: string | null
        unlock_rule: Record<string, unknown> | null
        unlock_at: string | null
        unlock_combiner: UnlockCombiner
        expiry_rule: Record<string, unknown> | null
        expires_at: string | null
        created_at: string
      }>

      const idMap = new Map<string, string>()

      for (const t of templates) {
        const generationAt = new Date(scheduledFor)
        const unlockRule = parseUnlockRule(t.unlock_rule)
        const expiryRule = parseExpiryRule(t.expiry_rule)
        const resolvedUnlockAt = resolveUnlockAt(unlockRule, generationAt, householdTimeZone)
        const shouldDeferUnlockBasedExpiry = isUnlockBasedDeferredExpiryRule(expiryRule)
        const resolvedExpiryAt = resolveExpiryAt({
          rule: expiryRule,
          generationAt,
          createdAt: generationAt,
          unlockAt: shouldDeferUnlockBasedExpiry ? null : resolvedUnlockAt,
          timeZone: householdTimeZone,
        })
        const materializedExpiryRule =
          shouldMaterializeToFixedOnOccurrence(expiryRule) && resolvedExpiryAt
            ? toFixedRuleFromInstant(resolvedExpiryAt, householdTimeZone)
            : expiryRule
        const ins = await client.query(
          `insert into tasks (
             household_id,
             routine_id,
             routine_occurrence_id,
             assignee_id,
             title,
             description,
             is_reward,
             status,
             position_x,
             position_y,
             scheduled_time,
             unlock_rule,
             unlock_at,
             unlock_combiner,
             expiry_rule,
             expires_at,
             created_by
           )
           values ($1, $2, $3, $4, $5, $6, $7, 'locked', $8, $9, $10, $11::jsonb, $12::timestamptz, $13, $14::jsonb, $15::timestamptz, $16)
           returning id`,
          [
            t.household_id,
            t.routine_id,
            newOccurrenceId,
            t.assignee_id,
            t.title,
            t.description,
            t.is_reward,
            t.position_x,
            t.position_y,
            t.scheduled_time,
            unlockRule && unlockRule.kind !== "none" ? JSON.stringify(unlockRule) : null,
            resolvedUnlockAt ? resolvedUnlockAt.toISOString() : null,
            t.unlock_combiner ?? "and",
            materializedExpiryRule && materializedExpiryRule.kind !== "none"
              ? JSON.stringify(materializedExpiryRule)
              : null,
            resolvedExpiryAt ? resolvedExpiryAt.toISOString() : null,
            userId,
          ],
        )
        idMap.set(t.id, ins.rows[0].id as string)
      }

      if (templates.length > 0) {
        const templateIds = templates.map((row) => row.id)
        const depsRes = await client.query<{ source_task_id: string; target_task_id: string }>(
          `select source_task_id, target_task_id
           from task_dependencies
           where source_task_id = any($1::uuid[])
             and target_task_id = any($1::uuid[])`,
          [templateIds],
        )
        for (const row of depsRes.rows) {
          const sourceId = idMap.get(row.source_task_id)
          const targetId = idMap.get(row.target_task_id)
          if (sourceId && targetId) {
            await client.query(
              `insert into task_dependencies (source_task_id, target_task_id)
               values ($1, $2)
               on conflict (source_task_id, target_task_id) do nothing`,
              [sourceId, targetId],
            )
          }
        }

        const assigneesRes = await client.query<{ task_id: string; user_id: string }>(
          `select task_id, user_id from task_assignees where task_id = any($1::uuid[])`,
          [templateIds],
        )
        for (const row of assigneesRes.rows) {
          const newTaskId = idMap.get(row.task_id)
          if (newTaskId) {
            await client.query(
              `insert into task_assignees (task_id, user_id)
               values ($1, $2)
               on conflict (task_id, user_id) do nothing`,
              [newTaskId, row.user_id],
            )
          }
        }

        await client.query(
          `insert into occurrence_tasks (occurrence_id, task_id, status)
           select $1::uuid, nt.id, 'locked'::task_status
           from tasks nt
           where nt.routine_occurrence_id = $1::uuid`,
          [newOccurrenceId],
        )
        await recomputeOccurrenceStatuses(client, newOccurrenceId)
        await materializeDeferredExpiryForUnlockedTasks(client, newOccurrenceId)
        await applyRewardAutoCompletion(client, newOccurrenceId)
      }

      if (routineCheck.rows[0]?.complete_older_occurrences_on_new) {
        await completeOlderRoutineOccurrences(client, routineId, newOccurrenceId)
      }

      await client.query("COMMIT")
      return NextResponse.json({ occurrence })
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }

  if (action === "addRecurrenceRule") {
    const routineId = String(body?.routineId ?? "").trim()
    if (!routineId) {
      return NextResponse.json({ error: "routineId is required" }, { status: 400 })
    }
    const existing = await db.query<{ recurrence_rule: string | null }>(
      `select recurrence_rule
       from routines
       where id = $1::uuid
         and household_id = $2
       limit 1`,
      [routineId, householdId],
    )
    if ((existing.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Routine not found" }, { status: 404 })
    }
    const nextRules = [
      ...parseRoutineRecurrenceRules(existing.rows[0]?.recurrence_rule),
      createDefaultRecurrenceRule(),
    ]
    const result = await db.query(
      `update routines
       set recurrence_rule = $1,
           updated_at = now()
       where id = $2::uuid
         and household_id = $3
       returning id, household_id, name, type, recurrence_rule, complete_older_occurrences_on_new`,
      [serializeRoutineRecurrenceRules(nextRules), routineId, householdId],
    )
    return NextResponse.json({ routine: result.rows[0], rules: nextRules })
  }

  if (action === "updateRecurrenceRule") {
    const routineId = String(body?.routineId ?? "").trim()
    const recurrenceRuleId = String(body?.recurrenceRuleId ?? "").trim()
    if (!routineId || !recurrenceRuleId) {
      return NextResponse.json({ error: "routineId and recurrenceRuleId are required" }, { status: 400 })
    }
    const existing = await db.query<{ recurrence_rule: string | null }>(
      `select recurrence_rule
       from routines
       where id = $1::uuid
         and household_id = $2
       limit 1`,
      [routineId, householdId],
    )
    if ((existing.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Routine not found" }, { status: 404 })
    }
    const rules = parseRoutineRecurrenceRules(existing.rows[0]?.recurrence_rule)
    const rulePatch = body?.rule ?? {}
    const nextRules = rules.map((rule) =>
      rule.id === recurrenceRuleId ? normalizeRecurrenceRule({ ...rule, ...rulePatch, id: recurrenceRuleId }) : rule,
    )
    const result = await db.query(
      `update routines
       set recurrence_rule = $1,
           updated_at = now()
       where id = $2::uuid
         and household_id = $3
       returning id, household_id, name, type, recurrence_rule, complete_older_occurrences_on_new`,
      [serializeRoutineRecurrenceRules(nextRules), routineId, householdId],
    )
    return NextResponse.json({ routine: result.rows[0], rules: nextRules })
  }

  if (action === "deleteRecurrenceRule") {
    const routineId = String(body?.routineId ?? "").trim()
    const recurrenceRuleId = String(body?.recurrenceRuleId ?? "").trim()
    if (!routineId || !recurrenceRuleId) {
      return NextResponse.json({ error: "routineId and recurrenceRuleId are required" }, { status: 400 })
    }
    const existing = await db.query<{ recurrence_rule: string | null }>(
      `select recurrence_rule
       from routines
       where id = $1::uuid
         and household_id = $2
       limit 1`,
      [routineId, householdId],
    )
    if ((existing.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Routine not found" }, { status: 404 })
    }
    const nextRules = parseRoutineRecurrenceRules(existing.rows[0]?.recurrence_rule).filter(
      (rule) => rule.id !== recurrenceRuleId,
    )
    const result = await db.query(
      `update routines
       set recurrence_rule = $1,
           updated_at = now()
       where id = $2::uuid
         and household_id = $3
       returning id, household_id, name, type, recurrence_rule, complete_older_occurrences_on_new`,
      [nextRules.length > 0 ? serializeRoutineRecurrenceRules(nextRules) : null, routineId, householdId],
    )
    return NextResponse.json({ routine: result.rows[0], rules: nextRules })
  }

  if (action === "createTaskBoard") {
    const title = String(body?.title ?? "").trim() || "New task board"
    const scheduledFor = String(body?.scheduledFor ?? new Date().toISOString())
    const result = await db.query(
      `insert into routine_occurrences (
         routine_id,
         household_id,
         kind,
         title,
         scheduled_for,
         status,
         created_by
       )
       values (null, $1, 'manual', $2, $3::timestamptz, 'active', $4)
       returning id, routine_id, household_id, kind, title, scheduled_for, status`,
      [householdId, title, scheduledFor, userId],
    )
    return NextResponse.json({ occurrence: result.rows[0] })
  }

  if (action === "renameTaskBoard") {
    const occurrenceId = String(body?.occurrenceId ?? "").trim()
    const title = String(body?.title ?? "").trim()
    if (!occurrenceId || !title) {
      return NextResponse.json({ error: "occurrenceId and title are required" }, { status: 400 })
    }
    const result = await db.query(
      `update routine_occurrences
       set title = $1,
           updated_at = now()
       where id = $2::uuid
         and household_id = $3
       returning id, routine_id, household_id, kind, title, scheduled_for, status`,
      [title, occurrenceId, householdId],
    )
    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Task board not found" }, { status: 404 })
    }
    return NextResponse.json({ occurrence: result.rows[0] })
  }

  if (action === "deleteOccurrence") {
    const occurrenceId = String(body?.occurrenceId ?? "")
    if (!occurrenceId) {
      return NextResponse.json({ error: "occurrenceId is required" }, { status: 400 })
    }

    const client = await db.connect()
    try {
      await client.query("BEGIN")
      const occurrenceMeta = await client.query<{
        id: string
        routine_id: string | null
        title: string | null
        scheduled_for: string
      }>(
        `select id, routine_id, title, scheduled_for
         from routine_occurrences
         where id = $1::uuid
           and household_id = $2::uuid
         limit 1`,
        [occurrenceId, householdId],
      )
      if ((occurrenceMeta.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK")
        return NextResponse.json({ error: "Occurrence not found" }, { status: 404 })
      }

      const row = occurrenceMeta.rows[0]
      await client.query(
        `delete from routine_occurrences
         where id = $1::uuid
           and household_id = $2::uuid`,
        [occurrenceId, householdId],
      )

      // If this was a recurrence-generated board, record the generated slot so it isn't recreated immediately.
      const recurrenceMatch = String(row.title ?? "").match(/^Recurrence - ([a-z0-9-]+)$/i)
      if (row.routine_id && recurrenceMatch) {
        const recurrenceRuleId = recurrenceMatch[1]
        const routineRes = await client.query<{ recurrence_rule: string | null }>(
          `select recurrence_rule
           from routines
           where id = $1::uuid
             and household_id = $2::uuid
           for update`,
          [row.routine_id, householdId],
        )
        if ((routineRes.rowCount ?? 0) > 0) {
          const rules = parseRoutineRecurrenceRules(routineRes.rows[0]?.recurrence_rule)
          const scheduledIso = new Date(row.scheduled_for).toISOString()
          let changed = false
          const nextRules = rules.map((rule) => {
            if (rule.id !== recurrenceRuleId) return rule
            if (rule.lastGeneratedAt === scheduledIso) return rule
            changed = true
            return { ...rule, lastGeneratedAt: scheduledIso }
          })
          if (changed) {
            await client.query(
              `update routines
               set recurrence_rule = $1,
                   updated_at = now()
               where id = $2::uuid
                 and household_id = $3::uuid`,
              [serializeRoutineRecurrenceRules(nextRules), row.routine_id, householdId],
            )
          }
        }
      }

      await client.query("COMMIT")
      return NextResponse.json({ ok: true })
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  if (action === "listOccurrenceTasks") {
    const occurrenceId = String(body?.occurrenceId ?? "")
    if (!occurrenceId) {
      return NextResponse.json({ error: "occurrenceId is required" }, { status: 400 })
    }

    const access = await db.query(
      `select 1
       from routine_occurrences ro
       where ro.id = $1::uuid
         and ro.household_id = $2
       limit 1`,
      [occurrenceId, householdId],
    )
    if ((access.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Occurrence not found" }, { status: 404 })
    }

    const tasks = await db.query(
      `select t.id,
              t.title,
              t.is_reward,
              ot.status,
              coalesce(
                array_agg(ta.user_id) filter (where ta.user_id is not null),
                '{}'::text[]
              ) as assignee_ids
       from occurrence_tasks ot
       join tasks t on t.id = ot.task_id
       left join task_assignees ta on ta.task_id = t.id
       where ot.occurrence_id = $1::uuid
       group by t.id, t.title, t.is_reward, ot.status, t.created_at
       order by t.created_at asc`,
      [occurrenceId],
    )
    const deps = await db.query(
      `select td.source_task_id, td.target_task_id
       from task_dependencies td
       where exists (
               select 1
               from occurrence_tasks ot
               where ot.occurrence_id = $1::uuid
                 and ot.task_id = td.source_task_id
             )
         and exists (
               select 1
               from occurrence_tasks ot2
               where ot2.occurrence_id = $1::uuid
                 and ot2.task_id = td.target_task_id
             )`,
      [occurrenceId],
    )
    return NextResponse.json({ tasks: tasks.rows, dependencies: deps.rows })
  }

  if (action === "listOccurrenceStatuses") {
    const occurrenceId = String(body?.occurrenceId ?? "")
    if (!occurrenceId) {
      return NextResponse.json({ error: "occurrenceId is required" }, { status: 400 })
    }
    const access = await db.query(
      `select 1
       from routine_occurrences ro
       where ro.id = $1::uuid
         and ro.household_id = $2
       limit 1`,
      [occurrenceId, householdId],
    )
    if ((access.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Occurrence not found" }, { status: 404 })
    }
    const statuses = await db.query<{ task_id: string; status: "locked" | "unlocked" | "completed" }>(
      `select task_id, status
       from occurrence_tasks
       where occurrence_id = $1::uuid`,
      [occurrenceId],
    )
    return NextResponse.json({
      occurrenceTaskStatuses: statuses.rows.map((row) => ({
        task_id: row.task_id,
        status: row.status,
      })),
    })
  }

  if (action === "setOccurrenceTaskCompleted") {
    const occurrenceId = String(body?.occurrenceId ?? "")
    const taskId = String(body?.taskId ?? "")
    const completed = Boolean(body?.completed)
    const actorMemberId = String(body?.actorMemberId ?? userId).trim() || userId
    const requestedEditableMemberIds = Array.isArray(body?.editableMemberIds)
      ? body.editableMemberIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const editableMemberIds = kioskSessionActive ? kioskSettings.editableMemberIds : requestedEditableMemberIds
    if (!occurrenceId || !taskId) {
      return NextResponse.json({ error: "occurrenceId and taskId are required" }, { status: 400 })
    }

    const client = await db.connect()
    const pushNotificationIds: string[] = []
    try {
      await client.query("BEGIN")

      const check = await client.query<{
        assignee_ids: string[]
      }>(
        `select coalesce(
            array_agg(ta.user_id) filter (where ta.user_id is not null),
            '{}'::text[]
          ) as assignee_ids
         from occurrence_tasks ot
         join routine_occurrences ro on ro.id = ot.occurrence_id
         join tasks t on t.id = ot.task_id
         left join task_assignees ta on ta.task_id = t.id
         where ot.occurrence_id = $1::uuid
           and ot.task_id = $2::uuid
           and ro.household_id = $3
         group by ot.occurrence_id, ot.task_id`,
        [occurrenceId, taskId, householdId],
      )
      if ((check.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK")
        return NextResponse.json({ error: "Occurrence task not found" }, { status: 404 })
      }
      const assigneeIds = check.rows[0]?.assignee_ids ?? []
      const canToggle = canEditMemberTasksInView({
        actorRole: membership.role,
        actorUserId: userId,
        leaderId: membership.leaderId,
        targetMemberId: actorMemberId,
        taskAssigneeIds: assigneeIds,
        editableMemberIds,
      })
      if (!canToggle) {
        await client.query("ROLLBACK")
        return NextResponse.json({ error: "Task cannot be edited in this view." }, { status: 403 })
      }

      const beforeStatuses = await client.query<{ task_id: string; status: "locked" | "unlocked" | "completed" }>(
        `select task_id, status
         from occurrence_tasks
         where occurrence_id = $1::uuid`,
        [occurrenceId],
      )
      const beforeByTaskId = new Map(beforeStatuses.rows.map((row) => [row.task_id, row.status]))

      if (completed) {
        await client.query(
          `update occurrence_tasks
           set status = 'completed',
               completed_at = coalesce(completed_at, now()),
               updated_at = now()
           where occurrence_id = $1::uuid and task_id = $2::uuid`,
          [occurrenceId, taskId],
        )
      } else {
        await client.query(
          `update occurrence_tasks
           set status = 'unlocked',
               completed_at = null,
               updated_at = now()
           where occurrence_id = $1::uuid and task_id = $2::uuid`,
          [occurrenceId, taskId],
        )
      }

      await recomputeOccurrenceStatuses(client, occurrenceId)
      await materializeDeferredExpiryForUnlockedTasks(client, occurrenceId)
      await applyRewardAutoCompletion(client, occurrenceId)

      const afterStatuses = await client.query<{ task_id: string; status: "locked" | "unlocked" | "completed" }>(
        `select task_id, status
         from occurrence_tasks
         where occurrence_id = $1::uuid`,
        [occurrenceId],
      )
      const unlockedTaskIds = afterStatuses.rows
        .filter((row) => row.status === "unlocked" && beforeByTaskId.get(row.task_id) === "locked")
        .map((row) => row.task_id)

      if (unlockedTaskIds.length > 0) {
        const unlockedTasks = await client.query<{
          id: string
          title: string
          is_reward: boolean
          assignee_ids: string[]
          unlock_at: string | null
        }>(
          `select t.id,
                  t.title,
                  t.is_reward,
                  t.unlock_at,
                  coalesce(
                    array_agg(ta.user_id) filter (where ta.user_id is not null),
                    '{}'::text[]
                  ) as assignee_ids
           from tasks t
           left join task_assignees ta on ta.task_id = t.id
           where t.id = any($1::uuid[])
           group by t.id, t.title, t.is_reward, t.unlock_at`,
          [unlockedTaskIds],
        )
        for (const unlockedTask of unlockedTasks.rows) {
          const dependencyResult = await client.query<{ has_dependency: boolean }>(
            `select exists(
               select 1
               from task_dependencies td
               where td.source_task_id = $1::uuid
                 and td.target_task_id = $2::uuid
             ) as has_dependency`,
            [taskId, unlockedTask.id],
          )
          const unlockCause =
            completed && Boolean(dependencyResult.rows[0]?.has_dependency)
              ? "prerequisite_completion"
              : "other"
          const notificationIds = await createUnlockNotifications(client, {
            householdId,
            actorUserId: actorMemberId,
            occurrenceId,
            taskId: unlockedTask.id,
            taskTitle: unlockedTask.title,
            isReward: Boolean(unlockedTask.is_reward),
            assigneeIds: unlockedTask.assignee_ids ?? [],
            unlockCause,
            unlockAt: unlockedTask.unlock_at,
            url: `/member/dashboard?household=${encodeURIComponent(householdId)}`,
          })
          pushNotificationIds.push(...notificationIds)
        }
      }

      await client.query("COMMIT")
      await dispatchPushForNotificationIds(pushNotificationIds)
      return NextResponse.json({
        ok: true,
        occurrenceTaskStatuses: afterStatuses.rows.map((row) => ({
          task_id: row.task_id,
          status: row.status,
        })),
      })
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }

  if (action === "createTask") {
    const routineId = String(body?.routineId ?? "").trim() || null
    const occurrenceId = String(body?.occurrenceId ?? "").trim() || null
    const title = String(body?.title ?? "New task").trim()
    const isReward = Boolean(body?.isReward)
    const assigneeIds = Array.isArray(body?.assigneeIds)
      ? body.assigneeIds.map((id: unknown) => String(id)).filter(Boolean)
      : []
    const assigneeId = assigneeIds[0] ?? null
    const notes = String(body?.notes ?? body?.recurrenceRule ?? "").trim()
    const unlockRule = parseUnlockRule(body?.unlockRule ?? null)
    const unlockCombiner: UnlockCombiner = body?.unlockCombiner === "or" ? "or" : "and"
    const expiryRule = parseExpiryRule(body?.expiryRule ?? null)
    const generationAt = new Date()
    const householdTimeZone = await getHouseholdTimeZone(db, householdId)
    const resolvedUnlockAt = resolveUnlockAt(unlockRule, generationAt, householdTimeZone)
    const resolvedExpiryAt = resolveExpiryAt({
      rule: expiryRule,
      generationAt,
      createdAt: generationAt,
      unlockAt: resolvedUnlockAt,
      timeZone: householdTimeZone,
    })

    if (occurrenceId) {
      const occCheck = await db.query(
        `select ro.id
         from routine_occurrences ro
         where ro.id = $1::uuid
           and ro.household_id = $2
         limit 1`,
        [occurrenceId, householdId],
      )
      if ((occCheck.rowCount ?? 0) === 0) {
        return NextResponse.json({ error: "Occurrence not found" }, { status: 404 })
      }
    }

    const result = await db.query(
      `insert into tasks (
         household_id, routine_id, routine_occurrence_id, title, is_reward, assignee_id, status, description,
         unlock_rule, unlock_at, unlock_combiner, expiry_rule, expires_at,
         created_by, position_x, position_y
       )
       values ($1, $2, $3, $4, $5, $6, 'locked', $7, $8::jsonb, $9::timestamptz, $10, $11::jsonb, $12::timestamptz, $13, $14, $15)
       returning id, household_id, routine_id, routine_occurrence_id, assignee_id, title, description, is_reward, status, position_x, position_y, scheduled_time, unlock_rule, unlock_at, unlock_combiner, expiry_rule, expires_at`,
      [
        householdId,
        routineId,
        occurrenceId,
        title,
        isReward,
        assigneeId,
        notes || null,
        unlockRule && unlockRule.kind !== "none" ? JSON.stringify(unlockRule) : null,
        resolvedUnlockAt ? resolvedUnlockAt.toISOString() : null,
        unlockCombiner,
        expiryRule && expiryRule.kind !== "none" ? JSON.stringify(expiryRule) : null,
        resolvedExpiryAt ? resolvedExpiryAt.toISOString() : null,
        userId,
        body?.positionX ?? null,
        body?.positionY ?? null,
      ],
    )
    if (assigneeIds.length > 0) {
      await db.query(
        `insert into task_assignees (task_id, user_id)
         select $1, unnest($2::text[])
         on conflict (task_id, user_id) do nothing`,
        [result.rows[0].id, assigneeIds],
      )
    }
    if (occurrenceId) {
      await db.query(
        `insert into occurrence_tasks (occurrence_id, task_id, status)
         values (
           $1::uuid,
           $2::uuid,
           case
             when exists (
               select 1
               from task_dependencies td
               join tasks st on st.id = td.source_task_id
               where td.target_task_id = $2::uuid
                 and st.routine_occurrence_id = $1::uuid
             )
             then 'locked'::task_status
             else 'unlocked'::task_status
           end
         )
         on conflict (occurrence_id, task_id) do nothing`,
        [occurrenceId, result.rows[0].id],
      )
      const client = await db.connect()
      try {
        await client.query("BEGIN")
        await recomputeOccurrenceStatuses(client, occurrenceId)
        await materializeDeferredExpiryForUnlockedTasks(client, occurrenceId)
        await applyRewardAutoCompletion(client, occurrenceId)
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }
    let occurrenceTaskStatus: { task_id: string; status: string } | null = null
    if (occurrenceId) {
      const occRow = await db.query<{ task_id: string; status: string }>(
        `select task_id, status::text as status
         from occurrence_tasks
         where occurrence_id = $1::uuid
           and task_id = $2::uuid
         limit 1`,
        [occurrenceId, result.rows[0].id],
      )
      if ((occRow.rowCount ?? 0) > 0 && occRow.rows[0]) {
        occurrenceTaskStatus = {
          task_id: String(occRow.rows[0].task_id),
          status: String(occRow.rows[0].status),
        }
      }
    }
    return NextResponse.json({ task: result.rows[0], occurrenceTaskStatus })
  }

  if (action === "updateTask") {
    const taskId = String(body?.taskId ?? "")
    const occurrenceId = String(body?.occurrenceId ?? "").trim() || null
    const title = String(body?.title ?? "").trim()
    const isReward = Boolean(body?.isReward)
    const assigneeIds = Array.isArray(body?.assigneeIds)
      ? body.assigneeIds.map((id: unknown) => String(id)).filter(Boolean)
      : []
    const assigneeId = assigneeIds[0] ?? null
    const notes = String(body?.notes ?? body?.recurrenceRule ?? "").trim() || null
    const unlockRule = parseUnlockRule(body?.unlockRule ?? null)
    const unlockCombiner: UnlockCombiner = body?.unlockCombiner === "or" ? "or" : "and"
    const expiryRule = parseExpiryRule(body?.expiryRule ?? null)
    const unlockAtOverrideRaw =
      typeof body?.unlockAtOverride === "string" && body.unlockAtOverride.trim() ? body.unlockAtOverride : null
    const expiryAtOverrideRaw =
      typeof body?.expiryAtOverride === "string" && body.expiryAtOverride.trim() ? body.expiryAtOverride : null
    const unlockAtOverride = unlockAtOverrideRaw ? new Date(unlockAtOverrideRaw) : null
    const expiryAtOverride = expiryAtOverrideRaw ? new Date(expiryAtOverrideRaw) : null
    if (unlockAtOverride && Number.isNaN(unlockAtOverride.getTime())) {
      return NextResponse.json({ error: "Invalid unlockAtOverride date" }, { status: 400 })
    }
    if (expiryAtOverride && Number.isNaN(expiryAtOverride.getTime())) {
      return NextResponse.json({ error: "Invalid expiryAtOverride date" }, { status: 400 })
    }
    const baselineDate = new Date()
    const householdTimeZone = await getHouseholdTimeZone(db, householdId)
    const resolvedUnlockAt =
      unlockAtOverride ?? resolveUnlockAt(unlockRule, baselineDate, householdTimeZone)
    const resolvedExpiryAt = expiryAtOverride ?? resolveExpiryAt({
      rule: expiryRule,
      generationAt: baselineDate,
      createdAt: baselineDate,
      unlockAt: resolvedUnlockAt,
      timeZone: householdTimeZone,
    })

    console.info("[api][updateTask] incoming", {
      householdId,
      taskId,
      occurrenceId,
      title,
      unlockRuleRaw: body?.unlockRule ?? null,
      unlockRuleParsed: unlockRule,
      unlockCombiner,
      resolvedUnlockAt: resolvedUnlockAt ? resolvedUnlockAt.toISOString() : null,
      expiryRuleRaw: body?.expiryRule ?? null,
      expiryRuleParsed: expiryRule,
      resolvedExpiryAt: resolvedExpiryAt ? resolvedExpiryAt.toISOString() : null,
    })

    const result = await db.query(
      `update tasks
       set title = $1,
           is_reward = $2,
           assignee_id = $3,
           description = $4,
           unlock_rule = $5::jsonb,
           unlock_at = $6::timestamptz,
           unlock_combiner = $7,
           expiry_rule = $8::jsonb,
           expires_at = $9::timestamptz,
           updated_at = now()
       where id = $10
         and household_id = $11
       returning id, household_id, routine_id, routine_occurrence_id, assignee_id, title, description, is_reward, status, position_x, position_y, scheduled_time, unlock_rule, unlock_at, unlock_combiner, expiry_rule, expires_at`,
      [
        title,
        isReward,
        assigneeId,
        notes,
        unlockRule && unlockRule.kind !== "none" ? JSON.stringify(unlockRule) : null,
        resolvedUnlockAt ? resolvedUnlockAt.toISOString() : null,
        unlockCombiner,
        expiryRule && expiryRule.kind !== "none" ? JSON.stringify(expiryRule) : null,
        resolvedExpiryAt ? resolvedExpiryAt.toISOString() : null,
        taskId,
        householdId,
      ],
    )
    console.info("[api][updateTask] update-result", {
      rowCount: result.rowCount ?? 0,
      returnedTask:
        result.rows[0]
          ? {
              id: result.rows[0].id,
              routine_occurrence_id: result.rows[0].routine_occurrence_id,
              unlock_rule: result.rows[0].unlock_rule,
              unlock_at: result.rows[0].unlock_at,
              unlock_combiner: result.rows[0].unlock_combiner,
              expiry_rule: result.rows[0].expiry_rule,
              expires_at: result.rows[0].expires_at,
            }
          : null,
    })
    if ((result.rowCount ?? 0) === 0) {
      return NextResponse.json({ error: "Task not found for update" }, { status: 404 })
    }
    const persistedCheck = await db.query(
      `select id, routine_occurrence_id, unlock_rule, unlock_at, unlock_combiner, expiry_rule, expires_at
       from tasks
       where id = $1::uuid
       limit 1`,
      [taskId],
    )
    console.info("[api][updateTask] persisted-check", {
      task:
        persistedCheck.rows[0]
          ? {
              id: persistedCheck.rows[0].id,
              routine_occurrence_id: persistedCheck.rows[0].routine_occurrence_id,
              unlock_rule: persistedCheck.rows[0].unlock_rule,
              unlock_at: persistedCheck.rows[0].unlock_at,
              unlock_combiner: persistedCheck.rows[0].unlock_combiner,
              expiry_rule: persistedCheck.rows[0].expiry_rule,
              expires_at: persistedCheck.rows[0].expires_at,
            }
          : null,
    })
    await db.query(`delete from task_assignees where task_id = $1`, [taskId])
    if (assigneeIds.length > 0) {
      await db.query(
        `insert into task_assignees (task_id, user_id)
         select $1, unnest($2::text[])
         on conflict (task_id, user_id) do nothing`,
        [taskId, assigneeIds],
      )
    }
    if (occurrenceId) {
      const client = await db.connect()
      try {
        await client.query("BEGIN")
        await recomputeOccurrenceStatuses(client, occurrenceId)
        await materializeDeferredExpiryForUnlockedTasks(client, occurrenceId)
        await applyRewardAutoCompletion(client, occurrenceId)
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }
    return NextResponse.json({ task: result.rows[0] })
  }

  if (action === "updateTaskPosition") {
    const taskId = String(body?.taskId ?? "")
    const x = Number(body?.x)
    const y = Number(body?.y)
    if (!taskId || Number.isNaN(x) || Number.isNaN(y)) {
      return NextResponse.json({ error: "taskId, x, and y are required" }, { status: 400 })
    }

    await db.query(
      `update tasks
       set position_x = $1,
           position_y = $2,
           updated_at = now()
       where id = $3 and household_id = $4`,
      [x, y, taskId, householdId],
    )
    return NextResponse.json({ ok: true })
  }

  if (action === "deleteTask") {
    const taskId = String(body?.taskId ?? "")
    const occurrenceId = String(body?.occurrenceId ?? "").trim() || null
    if (!taskId) {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 })
    }

    await db.query(
      `delete from tasks
       where id = $1
         and household_id = $2
         and (
           ($3::uuid is null and routine_occurrence_id is null)
           or routine_occurrence_id = $3::uuid
         )`,
      [taskId, householdId, occurrenceId],
    )
    return NextResponse.json({ ok: true })
  }

  if (action === "createDependency") {
    const sourceTaskId = String(body?.sourceTaskId ?? "")
    const targetTaskId = String(body?.targetTaskId ?? "")
    const occurrenceId = String(body?.occurrenceId ?? "").trim() || null
    if (!sourceTaskId || !targetTaskId) {
      return NextResponse.json({ error: "sourceTaskId and targetTaskId are required" }, { status: 400 })
    }

    const check = await db.query(
      `select count(*)::int as c
       from tasks
       where household_id = $4
         and id in ($1::uuid, $2::uuid)
         and (
           ($3::uuid is null and routine_occurrence_id is null)
           or routine_occurrence_id = $3::uuid
         )`,
      [sourceTaskId, targetTaskId, occurrenceId, householdId],
    )
    if (Number(check.rows[0]?.c) !== 2) {
      return NextResponse.json({ error: "Invalid dependency endpoints for this view" }, { status: 400 })
    }

    await db.query(
      `insert into task_dependencies (source_task_id, target_task_id)
       values ($1, $2)
       on conflict (source_task_id, target_task_id) do nothing`,
      [sourceTaskId, targetTaskId],
    )
    if (occurrenceId) {
      const client = await db.connect()
      try {
        await client.query("BEGIN")
        await recomputeOccurrenceStatuses(client, occurrenceId)
        await materializeDeferredExpiryForUnlockedTasks(client, occurrenceId)
        await applyRewardAutoCompletion(client, occurrenceId)
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }
    return NextResponse.json({ ok: true })
  }

  if (action === "deleteDependency") {
    const sourceTaskId = String(body?.sourceTaskId ?? "")
    const targetTaskId = String(body?.targetTaskId ?? "")
    const occurrenceId = String(body?.occurrenceId ?? "").trim() || null
    const ends = await db.query(
      `select count(*)::int as c
       from tasks
       where household_id = $4
         and id in ($1::uuid, $2::uuid)
         and (
           ($3::uuid is null and routine_occurrence_id is null)
           or routine_occurrence_id = $3::uuid
         )`,
      [sourceTaskId, targetTaskId, occurrenceId, householdId],
    )
    if (Number(ends.rows[0]?.c) !== 2) {
      return NextResponse.json({ error: "Invalid dependency endpoints for this view" }, { status: 400 })
    }
    await db.query(
      `delete from task_dependencies where source_task_id = $1 and target_task_id = $2`,
      [sourceTaskId, targetTaskId],
    )
    if (occurrenceId) {
      const client = await db.connect()
      try {
        await client.query("BEGIN")
        await recomputeOccurrenceStatuses(client, occurrenceId)
        await materializeDeferredExpiryForUnlockedTasks(client, occurrenceId)
        await applyRewardAutoCompletion(client, occurrenceId)
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }
    return NextResponse.json({ ok: true })
  }

  if (action === "insertIntoDependency") {
    const sourceTaskId = String(body?.sourceTaskId ?? "")
    const targetTaskId = String(body?.targetTaskId ?? "")
    const insertTaskId = String(body?.insertTaskId ?? "")
    const occurrenceId = String(body?.occurrenceId ?? "").trim() || null
    if (!sourceTaskId || !targetTaskId || !insertTaskId) {
      return NextResponse.json(
        { error: "sourceTaskId, targetTaskId, and insertTaskId are required" },
        { status: 400 },
      )
    }
    if (insertTaskId === sourceTaskId || insertTaskId === targetTaskId) {
      return NextResponse.json({ error: "insertTaskId must differ from edge endpoints" }, { status: 400 })
    }

    const check = await db.query(
      `select count(*)::int as c
       from tasks
       where household_id = $4
         and id in ($1::uuid, $2::uuid, $3::uuid)
         and (
           ($5::uuid is null and routine_occurrence_id is null)
           or routine_occurrence_id = $5::uuid
         )`,
      [sourceTaskId, targetTaskId, insertTaskId, householdId, occurrenceId],
    )
    if (Number(check.rows[0]?.c) !== 3) {
      return NextResponse.json({ error: "Invalid task endpoints for this view" }, { status: 400 })
    }

    const client = await db.connect()
    try {
      await client.query("BEGIN")
      const del = await client.query(
        `delete from task_dependencies where source_task_id = $1::uuid and target_task_id = $2::uuid`,
        [sourceTaskId, targetTaskId],
      )
      if ((del.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK")
        return NextResponse.json({ error: "Dependency edge not found" }, { status: 404 })
      }
      await client.query(
        `insert into task_dependencies (source_task_id, target_task_id)
         values ($1::uuid, $2::uuid)
         on conflict (source_task_id, target_task_id) do nothing`,
        [sourceTaskId, insertTaskId],
      )
      await client.query(
        `insert into task_dependencies (source_task_id, target_task_id)
         values ($1::uuid, $2::uuid)
         on conflict (source_task_id, target_task_id) do nothing`,
        [insertTaskId, targetTaskId],
      )
      await client.query("COMMIT")
    } catch (err) {
      try {
        await client.query("ROLLBACK")
      } catch {
        /* ignore */
      }
      throw err
    } finally {
      client.release()
    }

    if (occurrenceId) {
      const client2 = await db.connect()
      try {
        await client2.query("BEGIN")
        await recomputeOccurrenceStatuses(client2, occurrenceId)
        await materializeDeferredExpiryForUnlockedTasks(client2, occurrenceId)
        await applyRewardAutoCompletion(client2, occurrenceId)
        await client2.query("COMMIT")
      } catch (error) {
        await client2.query("ROLLBACK")
        throw error
      } finally {
        client2.release()
      }
    }
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
}
