import { randomUUID } from "node:crypto"
import type { Pool } from "pg"
import type { AccountDeletionWork } from "@/lib/account-deletion-requests"

type Phase = keyof AccountDeletionWork["phases"]
const phases: Phase[] = ["data","stripe","native","identity"]
export interface AccountDeletionJob {
  id: string; accountId: string; leaseId: string; work: AccountDeletionWork
}
/** Each adapter must be idempotent for job.id and verify its actual result.
 * Provider network calls must have bounded timeouts. An interrupted/expired
 * lease can retry a phase whose external effect already happened. */
export type AccountDeletionAdapters = Record<Phase,(job: AccountDeletionJob) => Promise<void>>
export class AccountDeletionProcessingError extends Error {
  constructor(public code: "data_cleanup_failed" | "stripe_cleanup_failed" | "native_cleanup_failed" | "identity_cleanup_failed") {super(code)}
}
interface LeaseRow {id:string;account_id:string;work:AccountDeletionWork;lease_id:string}

/** No process-local timers or promises own the job. Pending work, phase
 * acknowledgements, retries and leases are all durable in PostgreSQL. */
export async function processAccountDeletions(pool: Pool, adapters: AccountDeletionAdapters, maximum = 5, budgetMs = 20_000, now = () => performance.now()) {
  if (!Number.isInteger(maximum) || maximum<1 || maximum>100 || !Number.isFinite(budgetMs) || budgetMs<1 || budgetMs>60_000 || phases.some(phase=>typeof adapters[phase]!=="function")) throw new Error("Account deletion processing is not configured.")
  const deadline=now()+budgetMs
  const result={claimed:0,completed:0,retrying:0,interrupted:0}
  for(let index=0;index<maximum;index++) {
    if(now()>=deadline) break
    const leaseId=randomUUID()
    const row=(await pool.query<LeaseRow>(`with due as (
      select id from account_deletion_requests where state='pending' and next_attempt_at<=now()
        and (lease_until is null or lease_until<=now()) order by next_attempt_at,id for update skip locked limit 1
    ) update account_deletion_requests r set lease_id=$1,lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1
      from due where r.id=due.id returning r.id,r.account_id,r.work,r.lease_id`,[leaseId])).rows[0]
    if(!row) break
    result.claimed++
    const job:AccountDeletionJob={id:row.id,accountId:row.account_id,leaseId,work:row.work}
    try {
      let current=true
      for(const phase of phases) {
        if(job.work.phases[phase]) continue
        if(now()>=deadline) {
          await pool.query("update account_deletion_requests set lease_id=null,lease_until=null where id=$1 and lease_id=$2 and state='pending'",[job.id,leaseId])
          current=false;break
        }
        // Do not begin another external action if this worker lost its lease.
        if(!(await pool.query("select 1 from account_deletion_requests where id=$1 and lease_id=$2 and lease_until>clock_timestamp() and state='pending'",[job.id,leaseId])).rowCount){current=false;break}
        await adapters[phase](job)
        const saved=await pool.query(`update account_deletion_requests set work=jsonb_set(work,array['phases',$3],'true'::jsonb),last_error_code=null
          where id=$1 and lease_id=$2 and lease_until>clock_timestamp() and state='pending'`,[job.id,leaseId,phase])
        if(!saved.rowCount){current=false;break}
        job.work.phases[phase]=true
      }
      if(!current){result.interrupted++;continue}
      const completed=await pool.query(`update account_deletion_requests set state='completed',completed_at=clock_timestamp(),account_id=null,work='{}'::jsonb,
        next_attempt_at=null,lease_id=null,lease_until=null,last_error_code=null
        where id=$1 and lease_id=$2 and lease_until>clock_timestamp() and state='pending'
          and work->'phases' @> '{"data":true,"stripe":true,"native":true,"identity":true}'::jsonb`,[job.id,leaseId])
      if(completed.rowCount) result.completed++;else result.interrupted++
    } catch(error) {
      // Never persist an arbitrary provider exception: it can include private
      // request content, provider customer IDs, or authentication credentials.
      const code=error instanceof AccountDeletionProcessingError ? error.code : "cleanup_failed"
      const saved=await pool.query(`update account_deletion_requests set last_error_code=$3,lease_id=null,lease_until=null,
        next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,5*power(2,least(attempts-1,10)))::int)
        where id=$1 and lease_id=$2 and lease_until>clock_timestamp() and state='pending'`,[job.id,leaseId,code])
      if(saved.rowCount) result.retrying++;else result.interrupted++
    }
  }
  return result
}
