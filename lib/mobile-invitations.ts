import { db } from "@/lib/db"
import { normalizeRole } from "@/lib/household-authz"
import type { HouseholdInvitation, InvitationPage } from "@/shared/mobile/invitations"
import { isCalendarDate } from "@/shared/scheduling"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export class InvitationReadError extends Error { constructor(message: string, public status = 400) { super(message) } }

export async function readMobileInvitations(accountId: string, params: URLSearchParams): Promise<InvitationPage> {
  const householdId = params.get("householdId"), raw = params.get("cursor")
  if (!householdId || !uuid.test(householdId)) throw new InvitationReadError("Choose a valid household.")
  let after: { time: string; id: string } | null = null
  if (raw) {
    try {
      if (raw.length > 300 || !/^[\w-]+$/.test(raw)) throw new Error()
      after = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
      if (!after || typeof after.time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.time) ||
        !isCalendarDate(after.time.slice(0, 10)) || !Number.isFinite(Date.parse(after.time)) || typeof after.id !== "string" || !uuid.test(after.id)) throw new Error()
    } catch { throw new InvitationReadError("Refresh your invitations to continue.") }
  }
  const client = await db.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const membership = (await client.query<{ role: string }>("select role from household_members where household_id=$1 and user_id=$2", [householdId, accountId])).rows[0]
    if (!membership || normalizeRole(membership.role) !== "manager") throw new InvitationReadError("Only the household owner can manage invitations.", 403)
    const rows = (await client.query<HouseholdInvitation>(`select id,code,expires_at as "expiresAt",max_uses as "maxUses",uses_count as "usesCount",
      to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
      case when expires_at < now() then 'expired' when uses_count >= max_uses then 'used' else 'available' end as status
      from household_invites where household_id=$1 and is_active
      and ($2::timestamptz is null or (created_at,id)<($2::timestamptz,$3::uuid))
      order by created_at desc,id desc limit 26`, [householdId, after?.time ?? null, after?.id ?? null])).rows
    const items = rows.slice(0, 25), last = items.at(-1)
    await client.query("COMMIT")
    return { accountId, householdId, items, nextCursor: rows.length > 25 && last ? Buffer.from(JSON.stringify({ time: last.createdAt, id: last.id })).toString("base64url") : null }
  } catch (error) { await client.query("ROLLBACK"); throw error } finally { client.release() }
}
