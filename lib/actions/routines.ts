"use server"

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { db } from "@/lib/db"
import type { RoutineType } from "@/lib/types"

export async function createRoutine(formData: FormData) {
  const householdId = String(formData.get("householdId") ?? "")
  const name = String(formData.get("name") ?? "").trim()
  const type = String(formData.get("type") ?? "recurring") as RoutineType
  const recurrenceRule = String(formData.get("recurrenceRule") ?? "").trim() || null

  await db.query(
    `insert into routines (household_id, name, type, recurrence_rule)
     values ($1, $2, $3, $4)`,
    [householdId, name, type, recurrenceRule],
  )

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

  await db.query(
    `insert into tasks (household_id, routine_id, title, is_reward, assignee_id, scheduled_time, status)
     values ($1, $2, $3, $4, $5, $6, 'locked')`,
    [householdId, routineIdRaw || null, title, isReward, assigneeId, scheduledTime],
  )

  revalidatePath("/leader/dashboard")
  redirect(
    `/leader/dashboard?household=${householdId}${routineIdRaw ? `&routine=${routineIdRaw}` : ""}`,
  )
}
