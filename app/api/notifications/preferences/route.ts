import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { ensureCurrentUserRecord } from "@/lib/user-sync"
import { getHouseholdMembershipAuthz } from "@/lib/household-authz"

export async function GET(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()

  const { searchParams } = new URL(request.url)
  const householdId = String(searchParams.get("householdId") ?? "").trim()
  if (!householdId) return NextResponse.json({ error: "householdId is required" }, { status: 400 })
  const membership = await getHouseholdMembershipAuthz(householdId, userId)
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await db.query(
    `insert into notification_preferences (
       user_id, household_id,
       task_unlocked_self_enabled,
       task_unlocked_other_enabled,
       reward_unlocked_self_enabled,
       reward_unlocked_other_enabled,
       routine_occurrence_generated_enabled,
       member_joined_via_link_enabled,
       member_left_household_enabled
     )
     values ($1, $2::uuid, true, false, true, false, $3, $3, $3)
     on conflict (user_id, household_id) do nothing`,
    [userId, householdId, membership.role === "manager"],
  )

  const result = await db.query(
    `select user_id,
            household_id,
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
     where user_id = $1
       and household_id = $2::uuid
     limit 1`,
    [userId, householdId],
  )
  return NextResponse.json({ preferences: result.rows[0] ?? null })
}

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCurrentUserRecord()

  const body = await request.json()
  const householdId = String(body?.householdId ?? "").trim()
  if (!householdId) return NextResponse.json({ error: "householdId is required" }, { status: 400 })
  const membership = await getHouseholdMembershipAuthz(householdId, userId)
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const taskUnlockedSelfEnabled = Boolean(body?.taskUnlockedSelfEnabled)
  const taskUnlockedOtherEnabled = Boolean(body?.taskUnlockedOtherEnabled)
  const rewardUnlockedSelfEnabled = Boolean(body?.rewardUnlockedSelfEnabled)
  const rewardUnlockedOtherEnabled = Boolean(body?.rewardUnlockedOtherEnabled)
  const routineOccurrenceGeneratedEnabled = Boolean(body?.routineOccurrenceGeneratedEnabled)
  const memberJoinedViaLinkEnabled = Boolean(body?.memberJoinedViaLinkEnabled)
  const memberLeftHouseholdEnabled = Boolean(body?.memberLeftHouseholdEnabled)
  const taskUnlockedOtherMemberIds = Array.isArray(body?.taskUnlockedOtherMemberIds)
    ? body.taskUnlockedOtherMemberIds.map((id: unknown) => String(id).trim()).filter(Boolean)
    : []
  const rewardUnlockedOtherMemberIds = Array.isArray(body?.rewardUnlockedOtherMemberIds)
    ? body.rewardUnlockedOtherMemberIds.map((id: unknown) => String(id).trim()).filter(Boolean)
    : []

  const isManager = membership.role === "manager"
  const canSeeOther = membership.role === "manager" || membership.role === "supervisor"

  const result = await db.query(
    `insert into notification_preferences (
       user_id, household_id,
       task_unlocked_self_enabled,
       task_unlocked_other_enabled,
       reward_unlocked_self_enabled,
       reward_unlocked_other_enabled,
       routine_occurrence_generated_enabled,
       member_joined_via_link_enabled,
       member_left_household_enabled,
       task_unlocked_other_member_ids,
       reward_unlocked_other_member_ids,
       updated_at
     )
     values (
       $1,
       $2::uuid,
       $3,
       $4,
       $5,
       $6,
       $7,
       $8,
       $9,
       $10::jsonb,
       $11::jsonb,
       now()
     )
     on conflict (user_id, household_id)
     do update set
       task_unlocked_self_enabled = excluded.task_unlocked_self_enabled,
       task_unlocked_other_enabled = excluded.task_unlocked_other_enabled,
       reward_unlocked_self_enabled = excluded.reward_unlocked_self_enabled,
       reward_unlocked_other_enabled = excluded.reward_unlocked_other_enabled,
       routine_occurrence_generated_enabled = excluded.routine_occurrence_generated_enabled,
       member_joined_via_link_enabled = excluded.member_joined_via_link_enabled,
       member_left_household_enabled = excluded.member_left_household_enabled,
       task_unlocked_other_member_ids = excluded.task_unlocked_other_member_ids,
       reward_unlocked_other_member_ids = excluded.reward_unlocked_other_member_ids,
       updated_at = now()
     returning *`,
    [
      userId,
      householdId,
      taskUnlockedSelfEnabled,
      canSeeOther ? taskUnlockedOtherEnabled : false,
      rewardUnlockedSelfEnabled,
      canSeeOther ? rewardUnlockedOtherEnabled : false,
      isManager ? routineOccurrenceGeneratedEnabled : false,
      isManager ? memberJoinedViaLinkEnabled : false,
      isManager ? memberLeftHouseholdEnabled : false,
      JSON.stringify(canSeeOther ? taskUnlockedOtherMemberIds : []),
      JSON.stringify(canSeeOther ? rewardUnlockedOtherMemberIds : []),
    ],
  )
  return NextResponse.json({ preferences: result.rows[0] ?? null })
}
