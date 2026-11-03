import { clerkClient } from "@clerk/nextjs/server"
import type { PoolClient } from "pg"
import { db } from "@/lib/db"
import { householdLimits, resolveHouseholdTier, retainedTaskLimit, type HouseholdTier } from "@/lib/billing-policy"

const OWNER_EMAIL = "daniel@nexusaspyre.com"

export class EntitlementError extends Error {
  constructor(message: string, public status = 403) { super(message) }
}

/** Resolve only from Clerk's verified identity, never from editable app metadata. */
export async function ensurePermanentOwnerGrant(userId: string, client: PoolClient) {
  const existing = await client.query("select 1 from owner_entitlements where user_id = $1", [userId])
  if (existing.rowCount) return true
  const candidate = await client.query("select email from users where id = $1", [userId])
  if (candidate.rows[0]?.email?.toLowerCase() !== OWNER_EMAIL) return false
  const clerk = await clerkClient()
  const user = await clerk.users.getUser(userId)
  const verified = user.emailAddresses.some(address =>
    address.emailAddress.toLowerCase() === OWNER_EMAIL && address.verification?.status === "verified")
  if (!verified) return false
  await client.query(
    `insert into owner_entitlements (user_id, verified_email, verification_source)
     values ($1, $2, 'clerk_verified_email') on conflict (user_id) do nothing`,
    [userId, OWNER_EMAIL],
  )
  return true
}

export async function getHouseholdEntitlement(client: PoolClient, householdId: string) {
  const result = await client.query(
    `select h.leader_id, b.subscription_status, b.paid_through, b.free_routine_id, b.billing_hold
     from households h left join household_billing b on b.household_id = h.id
     where h.id = $1::uuid`, [householdId],
  )
  const row = result.rows[0]
  if (!row) throw new EntitlementError("Household not found", 404)
  const ownerGrant = await ensurePermanentOwnerGrant(row.leader_id, client)
  const rolloutPending = process.env.FREEMIUM_ENFORCEMENT_ENABLED === "false"
  const tier = ownerGrant ? "owner" : rolloutPending ? "premium" :
    resolveHouseholdTier({ownerGrant, subscriptionStatus: row.billing_hold ? "suspended" : row.subscription_status ?? "none", paidThrough: row.paid_through})
  return {tier, rolloutPending, limits: householdLimits(tier, process.env), freeRoutineId: row.free_routine_id as string | null, leaderId: row.leader_id as string}
}

/** Every quota-affecting write must use this same transaction/household lock. */
export async function withHouseholdWrite<T>(householdId: string, userId: string,
  operation: (client: PoolClient, entitlement: Awaited<ReturnType<typeof getHouseholdEntitlement>>) => Promise<T>) {
  const client = await db.connect()
  try {
    await client.query("begin")
    const lock = await client.query("select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired", [householdId])
    if (!lock.rows[0].acquired) throw new EntitlementError("Another household change is in progress. Please retry.", 429)
    const household = await client.query("select id from households where id = $1::uuid for update", [householdId])
    if (!household.rowCount) throw new EntitlementError("Household not found", 404)
    const membership = await client.query(
      "select role from household_members where household_id = $1::uuid and user_id = $2", [householdId, userId])
    if (!["manager", "supervisor", "leader"].includes(membership.rows[0]?.role)) {
      throw new EntitlementError("Household management access required")
    }
    const entitlement = await getHouseholdEntitlement(client, householdId)
    const result = await operation(client, entitlement)
    await client.query("commit")
    return result
  } catch (error) {
    await client.query("rollback")
    throw error
  } finally { client.release() }
}

export async function assertTemplateCapacity(client: PoolClient, householdId: string, maximum: number) {
  const count = await client.query("select count(*)::int as n from routines where household_id = $1::uuid", [householdId])
  if (count.rows[0].n >= maximum) throw new EntitlementError("Your household has reached its template limit. Upgrade or remove an unused template.", 402)
}

export async function assertRetainedTaskCapacity(client:PoolClient, householdId:string, tier:HouseholdTier, additional:number) {
  const stored = await client.query("select count(*)::int as n from tasks where household_id=$1::uuid",[householdId])
  if (stored.rows[0].n + additional > retainedTaskLimit(tier,process.env)) {
    throw new EntitlementError("This household has reached its retained task limit. Remove unneeded runs before adding more; existing history is preserved.",402)
  }
}

export async function assertTemplateItemCapacity(client: PoolClient, householdId: string, routineId: string, maximum: number, free: boolean) {
  const routine = await client.query("select id from routines where id = $1::uuid and household_id = $2::uuid", [routineId, householdId])
  if (!routine.rowCount) throw new EntitlementError("Template not found in this household", 404)
  if (free) {
    const selection = await client.query(
      `select coalesce(b.free_routine_id, (select id from routines where household_id = $1::uuid order by created_at, id limit 1)) as id
       from households h left join household_billing b on b.household_id = h.id where h.id = $1::uuid`, [householdId])
    if (selection.rows[0]?.id !== routineId) throw new EntitlementError("Select this as your free template before editing it.", 402)
  }
  const count = await client.query(
    "select count(*)::int as n from tasks where household_id = $1::uuid and routine_id = $2::uuid and routine_occurrence_id is null", [householdId, routineId])
  if (count.rows[0].n >= maximum) throw new EntitlementError("This template has reached its combined task and reward limit.", 402)
}
