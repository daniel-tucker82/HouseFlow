import { createHash } from "node:crypto"
import type { PoolClient } from "pg"
import { db } from "@/lib/db"
import { normalizeRole } from "@/lib/household-authz"
import { verifyInstallation } from "@/lib/native-notification-settings"
import { normalizeAccountDeletionIntent, AccountDeletionIntentError } from "@/shared/mobile/account-deletion"
import type { AccountDeletionScope, AccountDeletionReview, AccountDeletionHousehold, AccountDeletionIntent,
  DeletionContentCounts, DeletionBillingSource } from "@/shared/mobile/account-deletion"

export class AccountDeletionError extends Error {
  constructor(message: string, public status = 400, public code = "account_deletion_invalid") { super(message) }
}
const emptyCounts = (): DeletionContentCounts => ({ routines: 0, runs: 0, tasks: 0 })
type HouseholdRow = { id: string; name: string; leader_id: string; role: string | null }
type MemberRow = { household_id: string; id: string; name: string; role: string; linked: boolean }
type ContentRow = { household_id: string; kind: keyof DeletionContentCounts; count: number; authored: number; stamp: string | null }
type BillingRow = { household_id: string; provider: DeletionBillingSource["provider"]; environment: DeletionBillingSource["environment"];
  provider_id: string; status: string; renewal: string; pending_payment: boolean; access_through: string | null; verified_at: string | null }

/** Reused by acceptance under its account/household locks. A review fingerprint
 * is an optimistic concurrency check, never proof of authorization or consent. */
export async function reviewAccountDeletion(client: PoolClient, scope: AccountDeletionScope): Promise<AccountDeletionReview> {
  if (!(await client.query("select 1 from users where id=$1", [scope.accountId])).rowCount) throw new AccountDeletionError("Your account is no longer available.", 404, "account_unavailable")
  const households = (await client.query<HouseholdRow>(`select h.id,h.name,h.leader_id,hm.role::text
    from households h left join household_members hm on hm.household_id=h.id and hm.user_id=$1
    where hm.user_id=$1 or h.leader_id=$1 order by h.id`, [scope.accountId])).rows
  const owned = households.filter(household => household.leader_id === scope.accountId).map(household => household.id)
  const members = (await client.query<MemberRow>(`select hm.household_id,u.id,coalesce(nullif(u.full_name,''),'Household member') as name,
      hm.role::text,u.id like 'user\\_%' escape '\\' as linked
    from household_members hm join users u on u.id=hm.user_id where hm.household_id=any($1::uuid[]) order by hm.household_id,u.id`, [owned])).rows
  // IDs, rather than counts alone, detect replacement of records between review
  // and confirmation. Task completion does not change the deletion impact.
  const content = (await client.query<ContentRow>(`select household_id,kind,count(*)::int as count,
      count(*) filter(where created_by=$1)::int as authored,
      md5(string_agg(id::text||':'||coalesce(created_by,''),',' order by id)) as stamp
    from (
      select id,household_id,created_by,'routines' as kind from routines where household_id=any($2::uuid[]) or created_by=$1
      union all select id,household_id,created_by,'runs' from routine_occurrences where household_id=any($2::uuid[]) or created_by=$1
      union all select id,household_id,created_by,'tasks' from tasks where household_id=any($2::uuid[]) or created_by=$1
    ) affected group by household_id,kind order by household_id,kind`, [scope.accountId,owned])).rows
  // Include stored provider records even when the purchase feature is disabled.
  // This is a disclosure of the last verified state, not a live renewal promise.
  const billing = (await client.query<BillingRow>(`select household_id,'stripe' as provider,'unknown' as environment,
      stripe_subscription_id as provider_id,subscription_status as status,
      case when cancel_at_period_end or subscription_status in ('canceled','incomplete_expired') then 'will_not_renew' else 'unknown' end as renewal,
      subscription_status in ('incomplete','past_due','unpaid') as pending_payment,
      paid_through::text as access_through,last_reconciled_at::text as verified_at
    from household_billing where household_id=any($1::uuid[]) and stripe_subscription_id is not null
    union all select a.household_id,s.store,a.environment,s.subscription_id,s.status,s.auto_renewal_status,s.pending_payment,
      s.access_through::text,s.verified_at::text from native_billing_accounts a join native_subscriptions s on s.account_id=a.id
    where a.household_id=any($1::uuid[]) order by household_id,provider,environment,provider_id`, [owned])).rows
  const purchases = (await client.query<{ household_id: string; id: string; provider: string; state: string }>(`select household_id,id,provider,state
    from billing_purchase_attempts where household_id=any($1::uuid[]) and state in ('reserved','submitted') and expires_at>now()
    order by household_id,id`, [owned])).rows
  // Cleanup also concerns customer records without a subscription. Freeze their
  // bindings without exposing provider/customer IDs to the client.
  const bindings=(await client.query(`select household_id,'stripe' as provider,stripe_customer_id as id,'' as project,'' as environment
    from household_billing where household_id=any($1::uuid[]) and stripe_customer_id is not null
    union all select household_id,'native',id::text,project_id,environment from native_billing_accounts where household_id=any($1::uuid[])
    order by household_id,provider,id`,[owned])).rows
  const permanentOwnerAccess = Boolean((await client.query("select 1 from owner_entitlements where user_id=$1", [scope.accountId])).rowCount)
  const authoredContent = emptyCounts()
  for (const row of content) authoredContent[row.kind] += row.authored
  const result: AccountDeletionHousehold[] = households.map(household => {
    const owned = household.leader_id === scope.accountId
    const others = members.filter(member => member.household_id === household.id && member.id !== scope.accountId)
    const counts = emptyCounts()
    for (const row of content) if (row.household_id === household.id) counts[row.kind] = row.count
    return { id: household.id, name: household.name, role: normalizeRole(household.role), owned,
      ownership: owned ? {
        otherAccounts: others.filter(member => member.linked).length,
        profilesWithoutSignIn: others.filter(member => !member.linked).length,
        possibleSuccessors: others.flatMap(member => {
          const role = normalizeRole(member.role)
          return member.linked && role !== "member" ? [{ id: member.id, name: member.name, role }] : []
        }), content: counts,
        billing: billing.filter(source => source.household_id === household.id).map(source => ({ provider: source.provider,
          environment: source.environment,status: source.status,renewal: source.renewal,pendingPayment:source.pending_payment,accessThrough: source.access_through,verifiedAt: source.verified_at })),
        purchasePending: purchases.some(purchase => purchase.household_id === household.id),
      } : null }
  })
  const revision = createHash("sha256").update(JSON.stringify([scope,households,members,content,billing,purchases,bindings,permanentOwnerAccess])).digest("hex")
  return { ...scope,revision,reviewedAt:new Date().toISOString(),households:result,authoredContent,permanentOwnerAccess }
}

export async function readAccountDeletionReview(scope: AccountDeletionScope, secret: string) {
  const client = await db.connect()
  try {
    await client.query("begin isolation level repeatable read read only")
    await verifyInstallation(client,scope.deviceId,secret)
    // A first-install review needs no push registration or notification permission.
    // Existing installation secrets and durable session revocations still apply.
    if ((await client.query("select 1 from native_notification_revocations where device_id=$1 and account_id=$2 and session_id=$3",[scope.deviceId,scope.accountId,scope.sessionId])).rowCount) {
      throw new AccountDeletionError("Sign in again before reviewing account deletion.",403,"account_session_ended")
    }
    const result = await reviewAccountDeletion(client,scope)
    await client.query("commit")
    return result
  } catch (error) { await client.query("rollback"); throw error } finally { client.release() }
}

export function parseAccountDeletionIntent(value: unknown): AccountDeletionIntent {
  try { return normalizeAccountDeletionIntent(value) }
  catch (error) {
    if (error instanceof AccountDeletionIntentError) throw new AccountDeletionError(error.message)
    throw error
  }
}

export function validateAccountDeletionIntent(review: AccountDeletionReview, intent: AccountDeletionIntent) {
  if (review.revision !== intent.revision) throw new AccountDeletionError("Your households or subscriptions changed. Review account deletion again.",409,"account_deletion_review_changed")
  const owned = review.households.filter(household => household.owned)
  if (owned.length !== intent.ownership.length || owned.some(household => intent.ownership.filter(choice => choice.householdId === household.id).length !== 1)) throw new AccountDeletionError("Choose what happens to every household you own.")
  for (const household of owned) {
    const choice = intent.ownership.find(choice => choice.householdId === household.id)!
    if (choice.action === "transfer" && !household.ownership?.possibleSuccessors.some(member => member.id === choice.successorId)) throw new AccountDeletionError("That parent can no longer take over this household.",409,"account_deletion_review_changed")
  }
}
