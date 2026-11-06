"use server"

import { randomUUID } from "node:crypto"
import { validInvitationLimits } from "@/shared/mobile/invitations"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { lockActiveAccount } from "@/lib/account-access"
import { createHouseholdWithAdmission } from "@/lib/household-admission"
import { EntitlementError, withHouseholdWrite } from "@/lib/entitlements"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { ensureCurrentUserRecord } from "@/lib/user-sync"
import { createManagerNotificationEventInTransaction } from "@/lib/notifications"
import { dispatchPushForNotificationIds } from "@/lib/push"
import { requireTermsAcceptance } from "@/lib/terms-consent"

function makeInviteCode() {
  return randomUUID().replaceAll("-", "").slice(0, 12)
}

export async function createHousehold(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim()
  const timezone = String(formData.get("timezone") ?? "UTC").trim() || "UTC"
  await ensureCurrentUserRecord()
  const { userId } = await auth()
  if (!userId) {
    redirect("/auth/login")
  }

  const household = await createHouseholdWithAdmission(userId, name, timezone)
  const householdId = household.id

  revalidatePath("/leader/dashboard")
  redirect(`/leader/dashboard?household=${householdId}`)
}

export async function createInvite(formData: FormData) {
  const householdId = String(formData.get("householdId") ?? "")
  const maxUses = Number(formData.get("maxUses") ?? 10)
  const expiresInDays = Number(formData.get("expiresInDays") ?? 30)
  if (!validInvitationLimits(maxUses, expiresInDays)) {
    throw new EntitlementError("Choose 1–100 uses and an expiry of 1–365 days.", 400)
  }
  const code = makeInviteCode()
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)

  await ensureCurrentUserRecord()
  const { userId } = await auth()
  if (!userId) {
    redirect("/auth/login")
  }

  await enforceRequestLimit(userId, "write")
  await withHouseholdWrite(householdId, userId, async client => client.query(
    `insert into household_invites (household_id, created_by, code, max_uses, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [householdId, userId, code, maxUses, expiresAt.toISOString()],
  ))

  revalidatePath("/leader/dashboard")
  redirect(`/leader/dashboard?household=${householdId}&invite=${code}`)
}

export async function acceptInvite(formData: FormData) {
  const code = String(formData.get("inviteCode") ?? "").trim()
  const { userId } = await auth()
  if (!userId) {
    redirect(`/auth/login?next=${encodeURIComponent(`/join/${code}?autoJoin=1`)}`)
  }
  await ensureCurrentUserRecord()

  await acceptInviteByCode(code, userId)

  revalidatePath("/", "layout")
  redirect("/member/dashboard")
}

export async function acceptInviteByCode(code: string, userId: string) {
  const identity = await auth()
  if (!identity.userId || identity.userId !== userId) throw new EntitlementError("Sign in required", 401)
  await requireTermsAcceptance(db, userId)
  await enforceRequestLimit(userId, "write")
  const inviteCode = code.trim()
  if (!inviteCode) {
    throw new Error("Invite code is required.")
  }

  const client=await db.connect()
  let notificationIds: string[]=[]
  try {
    await client.query("begin")
    await client.query("set local lock_timeout='2s'")
    await lockActiveAccount(client,userId)
    const binding=(await client.query<{household_id:string}>("select household_id from household_invites where code=$1",[inviteCode])).rows[0]
    if(!binding) throw new Error("Invite not found.")
    const lock=await client.query<{acquired:boolean}>("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[binding.household_id])
    if(!lock.rows[0].acquired) throw new EntitlementError("Another household change is in progress. Please retry.",429)
    const inviteResult = await client.query(
      `select id, household_id, expires_at, max_uses, uses_count, is_active
       from household_invites
       where code = $1 and household_id=$2
       for update`,
      [inviteCode,binding.household_id],
    )
    const invite = inviteResult.rows[0]
    if (!invite) {
      throw new Error("Invite not found.")
    }

    const isExpired = new Date(invite.expires_at).getTime() < Date.now()
    const limitReached = invite.max_uses !== null && invite.uses_count >= invite.max_uses
    if (!invite.is_active || isExpired || limitReached) {
      throw new Error("Invite has expired or is inactive.")
    }

    const insertResult = await client.query(
      `insert into household_members (household_id, user_id, role)
       values ($1, $2, 'member')
       on conflict (household_id, user_id)
       do nothing`,
      [invite.household_id, userId],
    )

    // Only consume an invite use when this actually creates a new membership.
    if ((insertResult.rowCount ?? 0) > 0) {
      await client.query(
        `update household_invites
         set uses_count = uses_count + 1
         where id = $1`,
        [invite.id],
      )
      const memberInfo = await client.query<{ member_name: string; household_name: string }>(
        `select
            coalesce(u.full_name, u.email, u.id) as member_name,
            h.name as household_name
         from users u
         join households h on h.id = $2::uuid
         where u.id = $1
         limit 1`,
        [userId, invite.household_id],
      )
      const memberName = String(memberInfo.rows[0]?.member_name ?? "A household member")
      const householdName = String(memberInfo.rows[0]?.household_name ?? "household")
      notificationIds=await createManagerNotificationEventInTransaction(client,{
        householdId: String(invite.household_id),
        actorUserId: userId,
        subjectMemberId: userId,
        kind: "member_joined_via_link",
        title: "New member joined",
        body: `${memberName} has joined your ${householdName} household via link.`,
        metadata: {
          memberName,
          householdName,
          url: `/leader/dashboard?household=${encodeURIComponent(String(invite.household_id))}`,
        },
      })
    }
    await client.query("commit")
  } catch(error) {
    await client.query("rollback")
    throw error
  } finally {client.release()}
  await dispatchPushForNotificationIds(notificationIds)
}
