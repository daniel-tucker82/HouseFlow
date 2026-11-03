import { db } from "@/lib/db"
import { ensurePermanentOwnerGrant, EntitlementError } from "@/lib/entitlements"
import { clerkClient } from "@clerk/nextjs/server"
import { paidHouseholdAccessSql } from "@/lib/billing-access"
import { lockActiveAccount } from "@/lib/account-access"

export async function createHouseholdWithAdmission(userId: string, name: string, timezone: string) {
  if (name.length < 2 || name.length > 120) throw new EntitlementError("Household name must be 2–120 characters.", 400)
  try { new Intl.DateTimeFormat("en", {timeZone: timezone}) } catch { throw new EntitlementError("Invalid timezone", 400) }
  const identity = await (await clerkClient()).users.getUser(userId)
  if (!identity.emailAddresses.some(email => email.verification?.status === "verified")) {
    throw new EntitlementError("Verify your email before creating a household.")
  }
  const client = await db.connect()
  try {
    await client.query("begin")
    await lockActiveAccount(client,userId)
    // One admission lock makes global and per-account limits atomic across both write paths.
    const lock = await client.query("select pg_try_advisory_xact_lock(hashtextextended('cyntch-free-admission', 0)) as acquired")
    if (!lock.rows[0].acquired) throw new EntitlementError("Please retry household creation shortly.", 429)
    const owner = await ensurePermanentOwnerGrant(userId, client)
    if (!owner) {
      const owned = await client.query("select count(*)::int as n from households where leader_id = $1", [userId])
      if (owned.rows[0].n >= 1) throw new EntitlementError("One household per account is available during this rollout.", 402)
      const configured = Number(process.env.FREE_HOUSEHOLD_CAP ?? 500)
      const cap = Number.isSafeInteger(configured) && configured >= 0 ? configured : 500
      const free = await client.query(`select count(*)::int as n from households h
        left join owner_entitlements o on o.user_id = h.leader_id
        left join household_billing b on b.household_id = h.id
        where o.user_id is null and not ${paidHouseholdAccessSql("h.id", "b")}`)
      if (free.rows[0].n >= cap) {
        await client.query("insert into household_waitlist (user_id) values ($1) on conflict do nothing", [userId])
        await client.query("commit")
        throw new EntitlementError("Free household capacity is full. You are on the waitlist; existing households remain available.", 503)
      }
    }
    const result = await client.query(`insert into households (name, leader_id, timezone)
      values ($1,$2,$3) returning id, name, timezone, leader_id`, [name,userId,timezone])
    await client.query("insert into household_members (household_id,user_id,role) values ($1,$2,'manager')", [result.rows[0].id,userId])
    await client.query("insert into household_billing (household_id) values ($1)", [result.rows[0].id])
    await client.query("commit")
    return result.rows[0] as {id:string;name:string;timezone:string;leader_id:string}
  } catch (error) { await client.query("rollback"); throw error }
  finally { client.release() }
}
