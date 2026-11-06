"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { auth } from "@clerk/nextjs/server"
import { withHouseholdWrite, assertTemplateCapacity, assertTemplateItemCapacity, assertRetainedTaskCapacity, EntitlementError } from "@/lib/entitlements"
import type { RoutineType } from "@/lib/types"
import { requireTermsAcceptance } from "@/lib/terms-consent"

export async function createRoutine(formData: FormData) {
  const householdId = String(formData.get("householdId") ?? "")
  const name = String(formData.get("name") ?? "").trim()
  const type = String(formData.get("type") ?? "recurring") as RoutineType
  const recurrenceRule = String(formData.get("recurrenceRule") ?? "").trim() || null

  const { userId } = await auth()
  if (!userId) throw new EntitlementError("Sign in required", 401)
  if (!name || !["recurring", "one_off"].includes(type)) throw new EntitlementError("Invalid template", 400)
  await withHouseholdWrite(householdId, userId, async (client, entitlement) => {
  await requireTermsAcceptance(client, userId)
  if (recurrenceRule && !entitlement.limits.automation) throw new EntitlementError("Recurring schedules require Premium.", 402)
  await assertTemplateCapacity(client, householdId, entitlement.limits.templates)
  await client.query(
    `insert into routines (household_id, name, type, recurrence_rule)
     values ($1, $2, $3, $4)`,
    [householdId, name, type, recurrenceRule],
  )
  })

  revalidatePath("/leader/dashboard")
  redirect(`/leader/dashboard?household=${householdId}`)
}

export async function createTask(formData: FormData) {
  const householdId = String(formData.get("householdId") ?? "")
  const routineIdRaw = String(formData.get("routineId") ?? "")
  const title = String(formData.get("title") ?? "").trim()
  const isReward = String(formData.get("isReward") ?? "") === "on"
  const assigneeId = String(formData.get("assigneeId") ?? "").trim() || null
  const scheduledTime = String(formData.get("scheduledTime") ?? "").trim() || null

  const { userId } = await auth()
  if (!userId) throw new EntitlementError("Sign in required", 401)
  if (!title || title.length > 200 || !routineIdRaw) throw new EntitlementError("A title up to 200 characters and a template are required", 400)
  await withHouseholdWrite(householdId, userId, async (client, entitlement) => {
  await requireTermsAcceptance(client, userId)
  if (scheduledTime && !entitlement.limits.automation) throw new EntitlementError("Timed tasks require Premium.", 402)
  await assertRetainedTaskCapacity(client,householdId,entitlement.tier,1)
  await assertTemplateItemCapacity(client, householdId, routineIdRaw, entitlement.limits.items, entitlement.tier === "free")
  if (assigneeId) {
    const assignee = await client.query("select 1 from household_members where household_id = $1::uuid and user_id = $2", [householdId, assigneeId])
    if (!assignee.rowCount) throw new EntitlementError("Assignee is not a household member", 400)
  }
  await client.query(
    `insert into tasks (household_id, routine_id, title, is_reward, assignee_id, scheduled_time, status)
     values ($1, $2, $3, $4, $5, $6, 'locked')`,
    [householdId, routineIdRaw || null, title, isReward, assigneeId, scheduledTime],
  )
  })

  revalidatePath("/leader/dashboard")
  redirect(
    `/leader/dashboard?household=${householdId}${routineIdRaw ? `&routine=${routineIdRaw}` : ""}`,
  )
}
