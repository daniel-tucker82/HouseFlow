"use server"

import { randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"
import { auth } from "@clerk/nextjs/server"
import { db } from "@/lib/db"
import { ensureCurrentUserRecord } from "@/lib/user-sync"
import { createManagerNotificationEvent } from "@/lib/notifications"

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

  const householdResult = await db.query(
    `insert into households (name, leader_id, timezone)
     values ($1, $2, $3)
     returning id`,
    [name, userId, timezone],
  )
  const householdId = householdResult.rows[0]?.id as string | undefined
  if (!householdId) {
    redirect("/leader/dashboard?error=Unable%20to%20create%20household")
  }

  await db.query(
    `insert into household_members (household_id, user_id, role)
     values ($1, $2, 'manager')
     on conflict (household_id, user_id)
     do update set role = excluded.role`,
    [householdId, userId],
  )

  revalidatePath("/leader/dashboard")
  redirect(`/leader/dashboard?household=${householdId}`)
}

export async function createInvite(formData: FormData) {
  const householdId = String(formData.get("householdId") ?? "")
  const maxUses = Number(formData.get("maxUses") ?? 10)
  const expiresInDays = Number(formData.get("expiresInDays") ?? 30)
  const code = makeInviteCode()
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)

  await ensureCurrentUserRecord()
  const { userId } = await auth()
  if (!userId) {
    redirect("/auth/login")
  }

  await db.query(
    `insert into household_invites (household_id, created_by, code, max_uses, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [householdId, userId, code, maxUses, expiresAt.toISOString()],
  )

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
  const inviteCode = code.trim()
  if (!inviteCode) {
    throw new Error("Invite code is required.")
  }

  const inviteResult = await db.query(
    `select id, household_id, expires_at, max_uses, uses_count, is_active
     from household_invites
     where code = $1
     limit 1`,
    [inviteCode],
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

  const insertResult = await db.query(
    `insert into household_members (household_id, user_id, role)
     values ($1, $2, 'member')
     on conflict (household_id, user_id)
     do nothing`,
    [invite.household_id, userId],
  )

  // Only consume an invite use when this actually creates a new membership.
  if ((insertResult.rowCount ?? 0) > 0) {
    await db.query(
      `update household_invites
       set uses_count = uses_count + 1
       where id = $1`,
      [invite.id],
    )
    const memberInfo = await db.query<{ member_name: string; household_name: string }>(
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
    await createManagerNotificationEvent({
      householdId: String(invite.household_id),
      actorUserId: userId,
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
}
