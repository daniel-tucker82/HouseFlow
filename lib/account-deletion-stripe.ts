import type Stripe from "stripe"
import type { Pool } from "pg"
import { accountHash } from "@/lib/account-access"
import { AccountDeletionProcessingError, type AccountDeletionJob } from "@/lib/account-deletion-processing"
import type { AccountDeletionWork } from "@/lib/account-deletion-requests"
import { stripeClient } from "@/lib/stripe-billing"
import { inventoryAccountStripeCustomers } from "@/lib/account-deletion-stripe-inventory"

const failed = () => new AccountDeletionProcessingError("stripe_cleanup_failed")
type Provider = { client: Stripe; livemode: boolean }
function configured(): Provider {
  const key=process.env.STRIPE_SECRET_KEY ?? ""
  if(!/^[sr]k_(live|test)_/.test(key)) throw failed()
  return {client:stripeClient(),livemode:/^[sr]k_live_/.test(key)}
}

/** The customer is dedicated to one household. Deleting it stops renewals and
 * removes saved payment details. Stripe retains financial history; the app
 * keeps the transferred household's verified paid period and risk linkage.
 * Nothing is exposed as an HTTP action until all deletion phases are ready. */
export async function deleteAccountStripeData(pool: Pool, job: AccountDeletionJob, provider?: Provider, budgetMs=20_000) {
  if(!Number.isFinite(budgetMs) || budgetMs<1 || budgetMs>40_000) throw failed()
  const deadline=performance.now()+budgetMs
  const current=async()=>{
    const row=(await pool.query<{account_id:string|null;account_hash:string;work:AccountDeletionWork;state:string;current:boolean}>(`select *,
      lease_id=$2 and lease_until>clock_timestamp() as current from account_deletion_requests where id=$1`,[job.id,job.leaseId])).rows[0]
    if(!row || row.account_hash!==accountHash(job.accountId)) throw failed()
    if(row.state==='completed' || row.work.phases.stripe) return null
    if(row.account_id!==job.accountId || !row.current || !row.work.phases.data || !Array.isArray(row.work.stripe)
      || !Array.isArray(row.work.stripeHouseholds) || !row.work.stripeDiscovery) throw failed()
    return row.work
  }
  const options=async()=>{
    if(!await current()) throw failed()
    const remaining=Math.floor(deadline-performance.now())
    if(remaining<1) throw failed()
    return {timeout:Math.min(8_000,remaining),maxNetworkRetries:0}
  }
  try {
    let work=await current()
    if(!work || work.stripeDiscovery.finalized) return
    if(!work.stripeHouseholds.length && work.stripe.length) throw failed()
    if(work.stripeHouseholds.length) {
      provider ??= configured()
      const progress=await inventoryAccountStripeCustomers(work,provider.client,provider.livemode,options,async progress=>{
        const saved=await pool.query(`update account_deletion_requests set work=work||$4::jsonb where id=$1 and account_hash=$2 and lease_id=$3
          and lease_until>clock_timestamp() and state='pending'`,[job.id,accountHash(job.accountId),job.leaseId,JSON.stringify(progress)])
        if(!saved.rowCount) throw failed()
      })
      work={...work,...progress}
    } else work={...work,stripeDiscovery:{...work.stripeDiscovery,complete:true}}
    for(let index=0;index<work.stripe.length;index++) {
      const item=work.stripe[index]
      if(item.completed) continue
      const {client,livemode}=provider!
      let customerId=item.customerId
      if(!customerId && item.subscriptionId) {
        const subscription=await client.subscriptions.retrieve(item.subscriptionId,{},await options())
        if(subscription.id!==item.subscriptionId || subscription.livemode!==livemode || subscription.metadata.household_id!==item.householdId || subscription.metadata.app!=="cyntch") throw failed()
        customerId=typeof subscription.customer==='string'?subscription.customer:subscription.customer.id
      }
      if(!customerId) throw failed()
      // Never delete an ID now bound to a different household. A transferred
      // household must already have denied access to the old billing account.
      const bindings=(await pool.query<{household_id:string;stripe_customer_retired:boolean}>(`select household_id,stripe_customer_retired from household_billing
        where stripe_customer_id=$1 or ($2::text is not null and stripe_subscription_id=$2)`,[customerId,item.subscriptionId])).rows
      if(bindings.some(binding=>binding.household_id!==item.householdId || !binding.stripe_customer_retired)) throw failed()
      const customer=await client.customers.retrieve(customerId,{},await options())
      if(customer.id!==customerId) throw failed()
      if(!customer.deleted) {
        if(customer.livemode!==livemode || customer.metadata.app!=="cyntch" || customer.metadata.household_id!==item.householdId) throw failed()
        const deleted=await client.customers.del(customerId,{},await options())
        if(deleted.id!==customerId || deleted.deleted!==true) throw failed()
      }
      // A lost DELETE response retries via retrieve(deleted=true). An arbitrary
      // 404 is never proof of erasure: it may mean the wrong Stripe environment.
      const connection=await pool.connect()
      try {
        await connection.query("begin")
        await connection.query("set local lock_timeout='2s'")
        const locked=(await connection.query(`select 1 from account_deletion_requests where id=$1 and account_hash=$2 and lease_id=$3
          and lease_until>clock_timestamp() and state='pending' for update`,[job.id,accountHash(job.accountId),job.leaseId])).rowCount
        if(!locked) throw failed()
        if(!(await connection.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[item.householdId])).rows[0].acquired) throw failed()
        await connection.query(`update household_billing set subscription_status='canceled',cancel_at_period_end=true,updated_at=now()
          where household_id=$1 and stripe_customer_retired and (stripe_customer_id=$2 or (stripe_customer_id is null and stripe_subscription_id=$3))`,
          [item.householdId,customerId,item.subscriptionId])
        await connection.query(`update account_deletion_requests set work=jsonb_set(work,array['stripe',$2,'completed'],'true'::jsonb) where id=$1`,[job.id,String(index)])
        await connection.query("commit")
      } catch(error) {await connection.query("rollback");throw error} finally {connection.release()}
    }
    const connection=await pool.connect()
    try {
      await connection.query("begin")
      await connection.query("set local lock_timeout='2s'")
      const row=(await connection.query<{work:AccountDeletionWork}>(`select work from account_deletion_requests where id=$1 and account_hash=$2 and lease_id=$3
        and lease_until>clock_timestamp() and state='pending' for update`,[job.id,accountHash(job.accountId),job.leaseId])).rows[0]
      if(!row || row.work.stripe.some(item=>!item.completed) || (row.work.stripeHouseholds.length && !row.work.stripeDiscovery.complete)) throw failed()
      if(!row.work.stripeDiscovery.finalized) {
        const households=row.work.stripeHouseholds.filter(item=>item.action==='transfer').map(item=>item.householdId).sort()
        for(const id of households) if(!(await connection.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[id])).rows[0].acquired) throw failed()
        // Unlock replacement purchases only after every discovered customer is
        // erased. Save finalization atomically so a lost phase acknowledgement
        // cannot later close or unlock a successor's new billing account.
        await connection.query(`update household_billing set stripe_customer_deleted_at=coalesce(stripe_customer_deleted_at,clock_timestamp()),
          subscription_status='canceled',cancel_at_period_end=true,updated_at=now() where household_id=any($1::uuid[]) and stripe_customer_retired`,[households])
        await connection.query(`update billing_purchase_attempts set state='released',updated_at=now()
          where household_id=any($1::uuid[]) and user_id='deleted' and provider='stripe' and state in ('reserved','submitted')`,[households])
        await connection.query(`update account_deletion_requests set work=jsonb_set(work,'{stripeDiscovery}', $2::jsonb) where id=$1`,
          [job.id,JSON.stringify({...row.work.stripeDiscovery,complete:true,finalized:true})])
      }
      await connection.query("commit")
    } catch(error) {await connection.query("rollback");throw error} finally {connection.release()}
  } catch {throw failed()}
}
