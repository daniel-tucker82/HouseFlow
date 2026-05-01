import { NextResponse } from "next/server"
import type { PoolClient } from "pg"
import { db } from "@/lib/db"
import { ensureRoutineSchemaColumns } from "@/lib/schema-ensure"
import { parseExpiryRule, parseUnlockRule, resolveExpiryAt, resolveUnlockAt, type UnlockCombiner } from "@/lib/time-rules"
import {
  latestRecurrenceAtOrBefore,
  parseRoutineRecurrenceRules,
  recurrenceRuleSummary,
  serializeRoutineRecurrenceRules,
} from "@/lib/recurrence"
import { createManagerNotificationEventInTransaction } from "@/lib/notifications"
import { dispatchPushForNotificationIds } from "@/lib/push"

function authorizedByCronSecret(request: Request) {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return process.env.NODE_ENV !== "production"
  const bearer = request.headers.get("authorization") ?? ""
  return bearer === `Bearer ${secret}`
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
  return {
    kind: "fixed",
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")}`,
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
  return kind === "after_unlock" || kind === "weekday_after_unlock" || kind === "month_day_after_unlock"
}

async function getHouseholdTimeZone(client: PoolClient, householdId: string) {
  const result = await client.query<{ timezone?: string | null }>(
    `select timezone from households where id = $1::uuid limit 1`,
    [householdId],
  )
  return String(result.rows[0]?.timezone ?? "UTC")
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
  await client.query(
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

async function materializeDueRecurrences(
  client: PoolClient,
  householdId: string,
  actorUserId: string | null,
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
        [routine.id, householdId, `Recurrence - ${rule.id}`, dueIso, actorUserId],
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
                expires_at
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
            actorUserId,
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
        actorUserId,
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

      console.info("[cron][materializeDueRecurrences] created occurrence", {
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

export async function GET(request: Request) {
  if (!authorizedByCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  await ensureRoutineSchemaColumns()
  const households = await db.query<{ id: string; leader_id: string | null }>(
    `select id, leader_id
     from households`,
  )

  const pushNotificationIds: string[] = []
  let householdsProcessed = 0
  let householdsFailed = 0

  for (const household of households.rows) {
    const client = await db.connect()
    try {
      await client.query("BEGIN")
      pushNotificationIds.push(...(await materializeDueRecurrences(client, household.id, household.leader_id ?? null)))
      await client.query("COMMIT")
      householdsProcessed += 1
    } catch (error) {
      await client.query("ROLLBACK")
      householdsFailed += 1
      console.error("[cron][recurrence] household materialization failed", {
        householdId: household.id,
        error,
      })
    } finally {
      client.release()
    }
  }

  await dispatchPushForNotificationIds(pushNotificationIds)
  return NextResponse.json({
    ok: householdsFailed === 0,
    householdsProcessed,
    householdsFailed,
    notificationsDispatched: pushNotificationIds.length,
  })
}
