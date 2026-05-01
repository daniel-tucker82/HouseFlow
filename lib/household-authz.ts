import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { db } from "@/lib/db"
import type { AppRole } from "@/lib/types"

export type EffectiveRole = "manager" | "supervisor" | "member"

export type HouseholdMembershipAuthz = {
  householdId: string
  userId: string
  role: EffectiveRole
  leaderId: string
}

export type HouseholdKioskSettings = {
  householdId: string
  visibleMemberIds: string[]
  editableMemberIds: string[]
  kioskActive: boolean
  pinHash: string | null
  sessionTokenHash: string | null
}

export function normalizeRole(role: string | null | undefined): EffectiveRole {
  if (role === "manager" || role === "supervisor" || role === "member") return role
  if (role === "leader") return "manager"
  return "member"
}

export function isManagementRole(role: EffectiveRole) {
  return role === "manager" || role === "supervisor"
}

export function canCreateHousehold(role: EffectiveRole) {
  return role === "manager"
}

const managerOnlyActions = new Set<string>([
  "createHouseholdMember",
  "removeHouseholdMember",
  "createInvite",
  "deactivateInvite",
  "updateKioskSettings",
  "activateKioskMode",
  "updateMemberRole",
  "renameHouseholdMember",
])
const managementActions = new Set<string>([
  "createRoutine",
  "renameRoutine",
  "updateMemberTokenColor",
  "updateRoutineRecurrenceSettings",
  "createOccurrence",
  "addRecurrenceRule",
  "updateRecurrenceRule",
  "deleteRecurrenceRule",
  "createTaskBoard",
  "renameTaskBoard",
  "deleteOccurrence",
  "listOccurrenceTasks",
  "listOccurrenceStatuses",
  "createTask",
  "updateTask",
  "updateTaskPosition",
  "deleteTask",
  "createDependency",
  "deleteDependency",
  "insertIntoDependency",
])

export function canPerformAction(role: EffectiveRole, action: string) {
  if (managerOnlyActions.has(action)) return role === "manager"
  if (managementActions.has(action)) return isManagementRole(role)
  if (action === "setOccurrenceTaskCompleted") return true
  if (action === "listOccurrenceStatuses") return true
  if (action === "verifyKioskExitPin" || action === "forgotKioskPinAndSignOut") return isManagementRole(role)
  return false
}

export function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

export function constantTimeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.length !== rightBytes.length) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

export function hashPin(pin: string) {
  const salt = randomBytes(16).toString("hex")
  const digest = scryptSync(pin, salt, 64).toString("hex")
  return `${salt}:${digest}`
}

export function verifyPinHash(storedHash: string, pin: string) {
  const [salt, digest] = storedHash.split(":", 2)
  if (!salt || !digest) return false
  const candidate = scryptSync(pin, salt, 64).toString("hex")
  return constantTimeEqual(digest, candidate)
}

export async function getHouseholdMembershipAuthz(
  householdId: string,
  userId: string,
): Promise<HouseholdMembershipAuthz | null> {
  const result = await db.query<{ role: AppRole; leader_id: string }>(
    `select hm.role, h.leader_id
     from household_members hm
     join households h on h.id = hm.household_id
     where hm.household_id = $1::uuid
       and hm.user_id = $2
     limit 1`,
    [householdId, userId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    householdId,
    userId,
    role: normalizeRole(row.role),
    leaderId: String(row.leader_id),
  }
}

export async function getHouseholdKioskSettings(householdId: string): Promise<HouseholdKioskSettings> {
  let row:
    | {
        household_id: string
        visible_member_ids: string[] | null
        editable_member_ids: string[] | null
        kiosk_active: boolean
        pin_hash: string | null
        session_token_hash: string | null
      }
    | undefined
  try {
    const result = await db.query<{
      household_id: string
      visible_member_ids: string[] | null
      editable_member_ids: string[] | null
      kiosk_active: boolean
      pin_hash: string | null
      session_token_hash: string | null
    }>(
      `select household_id, visible_member_ids, editable_member_ids, kiosk_active, pin_hash, session_token_hash
       from household_kiosk_settings
       where household_id = $1::uuid
       limit 1`,
      [householdId],
    )
    row = result.rows[0]
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== "42P01") throw error
  }
  if (!row) {
    return {
      householdId,
      visibleMemberIds: [],
      editableMemberIds: [],
      kioskActive: false,
      pinHash: null,
      sessionTokenHash: null,
    }
  }
  return {
    householdId: row.household_id,
    visibleMemberIds: row.visible_member_ids ?? [],
    editableMemberIds: row.editable_member_ids ?? [],
    kioskActive: Boolean(row.kiosk_active),
    pinHash: row.pin_hash,
    sessionTokenHash: row.session_token_hash,
  }
}

export function canEditMemberTasksInView(options: {
  actorRole: EffectiveRole
  actorUserId: string
  leaderId: string
  targetMemberId: string
  taskAssigneeIds: string[]
  editableMemberIds: string[]
}) {
  const { actorRole, actorUserId, leaderId, targetMemberId, taskAssigneeIds, editableMemberIds } = options
  if (isManagementRole(actorRole)) {
    if (editableMemberIds.length === 0) return true
    return editableMemberIds.includes(targetMemberId)
  }

  if (targetMemberId !== actorUserId) return false
  if (taskAssigneeIds.length === 0) return actorUserId === leaderId
  return taskAssigneeIds.includes(actorUserId)
}

export async function resolveActiveKioskHouseholdFromCookie(
  kioskCookieValue: string | null | undefined,
): Promise<string | null> {
  if (!kioskCookieValue) return null
  const [householdId, sessionToken] = kioskCookieValue.split(":", 2)
  if (!householdId || !sessionToken) return null

  const settings = await getHouseholdKioskSettings(householdId)
  if (!settings.kioskActive || !settings.sessionTokenHash) return null
  const expectedTokenHash = sha256(sessionToken)
  if (!constantTimeEqual(settings.sessionTokenHash, expectedTokenHash)) return null
  return householdId
}

