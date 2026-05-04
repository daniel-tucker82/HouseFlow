"use server"

import { revalidatePath } from "next/cache"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { normalizeRole } from "@/lib/household-authz"
import { ensureCurrentUserRecord } from "@/lib/user-sync"

export type SaveMemberDashboardLanePreferencesResult =
  | { ok: true }
  | { ok: false; error: string }

export async function saveMemberDashboardLanePreferences(
  householdId: string,
  visibleMemberIds: string[],
  editableMemberIds: string[],
): Promise<SaveMemberDashboardLanePreferencesResult> {
  await ensureCurrentUserRecord()
  const { userId } = await auth()
  if (!userId) {
    return { ok: false, error: "Unauthorized" }
  }

  const hh = householdId.trim()
  if (!hh) {
    return { ok: false, error: "householdId is required" }
  }

  const membership = await db.query<{ role: string }>(
    `select role from household_members where household_id = $1::uuid and user_id = $2`,
    [hh, userId],
  )
  const effective = normalizeRole(membership.rows[0]?.role)
  if (effective !== "manager" && effective !== "supervisor") {
    return { ok: false, error: "Only managers and supervisors can save lane preferences." }
  }

  const members = await db.query<{ user_id: string }>(
    `select user_id from household_members where household_id = $1::uuid`,
    [hh],
  )
  const valid = new Set(members.rows.map((r) => r.user_id))
  const visible = visibleMemberIds.filter((id) => valid.has(id))
  if (visible.length === 0) {
    return { ok: false, error: "At least one household member lane must stay visible." }
  }

  const visibleSet = new Set(visible)
  const editable = editableMemberIds.filter((id) => visibleSet.has(id))
  const editableStored = editable.length > 0 ? editable : visible

  try {
    await db.query(
      `insert into member_dashboard_lane_preferences (
         user_id, household_id, visible_member_ids, editable_member_ids, updated_at
       )
       values ($1, $2::uuid, $3::text[], $4::text[], now())
       on conflict (user_id, household_id)
       do update set
         visible_member_ids = excluded.visible_member_ids,
         editable_member_ids = excluded.editable_member_ids,
         updated_at = excluded.updated_at`,
      [userId, hh, visible, editableStored],
    )
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === "42P01") {
      return {
        ok: false,
        error: "Database is missing the lane-preferences table. Run npm run db:migrate, then try again.",
      }
    }
    throw error
  }

  revalidatePath("/member/dashboard")
  return { ok: true }
}
