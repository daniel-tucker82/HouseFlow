import { db } from "@/lib/db"
import { processAccountDeletions } from "@/lib/account-deletion-processing"
import { deleteAccountData } from "@/lib/account-deletion-data"
import { deleteAccountStripeData } from "@/lib/account-deletion-stripe"
import { deleteAccountNativeData } from "@/lib/account-deletion-native"
import { deleteAccountIdentity } from "@/lib/account-deletion-identity"

/** Independent of submission/purchase rollout: accepted requests must remain
 * drainable when new submissions or purchases are disabled. Keep this gate off
 * until provider credentials and the complete deletion flow are verified. */
export async function runAccountDeletions() {
  if(process.env.ACCOUNT_DELETION_PROCESSING_ENABLED!=="true") return {enabled:false,ok:true}
  try {
    const result=await processAccountDeletions(db,{
      data:(job,budget)=>deleteAccountData(db,job,budget),
      stripe:(job,budget)=>deleteAccountStripeData(db,job,undefined,budget),
      native:(job,budget)=>deleteAccountNativeData(db,job,undefined,budget),
      identity:(job,budget)=>deleteAccountIdentity(db,job,undefined,budget),
    },5,20_000)
    // Failed jobs remain unhealthy during backoff; a quiet tick must not report
    // recovery merely because the failed request is not due yet. Planned waits
    // and budget yields have no error code and are ordinary pending work.
    const health=(await db.query<{pending:number;failed:number}>(`select count(*)::int as pending,
      count(*) filter(where last_error_code is not null)::int as failed
      from account_deletion_requests where state='pending'`)).rows[0]
    const status={enabled:true,ok:health.failed===0,...result,...health}
    if(status.ok) console.info("[account-deletion] batch complete",status)
    else console.warn("[account-deletion] cleanup needs retry",status)
    return status
  } catch {
    // No job IDs, account IDs, receipt secrets or provider response bodies.
    console.error("[account-deletion] processing failed")
    return {enabled:true,ok:false,error:"Account deletion processing needs retry"}
  }
}
