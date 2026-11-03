import type { Pool } from "pg"
import { accountAccessKey, accountHash, accountAccessDatabaseError, assertAccountActive } from "@/lib/account-access"
import { AccountDeletionError } from "@/lib/account-deletion-review"
import { accountDeletionIssuer } from "@/lib/account-deletion-identity"
import { accountDeletionRecoveryHash } from "@/lib/account-deletion-status"
import { verifyInstallation } from "@/lib/native-notification-settings"
import { kioskSessionKey, readKioskForSession } from "@/lib/native-kiosk-store"
import { notificationUuid, notificationSessionId } from "@/shared/mobile/notification-settings"
import { validAccountDeletionRecovery, type AccountDeletionScope, type AccountDeletionRecovery, type AccountDeletionWithdrawalResult } from "@/shared/mobile/account-deletion"

const busy = () => new AccountDeletionError("Another account or household change is in progress. Please retry.",429,"account_deletion_busy")
const mismatch = () => new AccountDeletionError("This attempt does not match the saved recovery information. Check its status.",409,"account_deletion_request_exists")

/** Current, strictly reverified identity is required. The recovery key alone
 * never authorizes this mutation. A new sign-in by the SAME account may retire
 * its old attempt; it cannot cancel an already accepted deletion or edit it.
 * Do not wrap this in shared account admission: it takes its own exclusive lock. */
export async function withdrawAccountDeletion(pool: Pool, scope: AccountDeletionScope, installationSecret: string,
  recovery: AccountDeletionRecovery, recentlyVerified: boolean, verifiedSessionIssuer: string): Promise<AccountDeletionWithdrawalResult> {
  if (!/^user_[A-Za-z0-9_-]{1,200}$/.test(scope.accountId) || !notificationSessionId.test(scope.sessionId) || !notificationUuid.test(scope.deviceId) || !accountDeletionIssuer(verifiedSessionIssuer)) {
    throw new AccountDeletionError("Sign in again before withdrawing this attempt.",401)
  }
  if (!recentlyVerified) throw new AccountDeletionError("Verify your sign-in again before withdrawing this attempt.",403,"account_reverification_required")
  if (!validAccountDeletionRecovery(recovery)) throw new AccountDeletionError("The saved recovery information is unavailable.")
  const ownerHash = accountHash(scope.accountId), recoveryHash = accountDeletionRecoveryHash(recovery.secret)
  // Charge attempts outside the decision transaction, including failed retries.
  // Do not use normal account admission: an accepted request must be reportable.
  const limited = await pool.query(`insert into application_rate_limits(bucket_key,window_start,requests) values($1,date_trunc('minute',now()),1)
    on conflict(bucket_key,window_start) do update set requests=application_rate_limits.requests+1 where application_rate_limits.requests<10 returning requests`, [`deletion-withdrawal:${ownerHash}`])
  if (!limited.rowCount) throw new AccountDeletionError("Please wait a minute before withdrawing this attempt again.",429,"account_deletion_limited")
  const client = await pool.connect()
  try {
    await client.query("begin")
    await client.query("set local lock_timeout='2s'")
    await client.query("set local statement_timeout='15s'")
    for (const key of [accountAccessKey(scope.accountId),`account-deletion-operation:${recovery.requestId}`]) {
      if (!(await client.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[key])).rows[0].acquired) throw busy()
    }
    if (!(await client.query("select pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) as acquired",[kioskSessionKey(scope.sessionId)])).rows[0].acquired) throw busy()
    if (!(await client.query("select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",[`native-device:${scope.deviceId}`])).rows[0].acquired) throw busy()
    await verifyInstallation(client,scope.deviceId,installationSecret)
    if ((await client.query("select 1 from native_notification_revocations where account_id=$1 and device_id=$2 and session_id=$3",[scope.accountId,scope.deviceId,scope.sessionId])).rowCount) {
      throw new AccountDeletionError("This sign-in session has ended.",403,"account_session_ended")
    }
    const kiosk = await readKioskForSession(client,scope.accountId,scope.sessionId)
    if ((kiosk && kiosk.state !== "unlocked") || (await client.query("select 1 from native_kiosk_sessions where device_id=$1 and state='locked'",[scope.deviceId])).rowCount) {
      throw new AccountDeletionError("Unlock kiosk mode before withdrawing this attempt.",423)
    }
    const base = { ...scope, requestId: recovery.requestId }
    const accepted = (await client.query<{ account_hash: string; recovery_key_hash: string | null }>("select account_hash,recovery_key_hash from account_deletion_requests where id=$1",[recovery.requestId])).rows[0]
    if (accepted) {
      if (accepted.account_hash !== ownerHash || accepted.recovery_key_hash !== recoveryHash) throw mismatch()
      await client.query("commit"); return { ...base, outcome: "accepted", withdrawnAt: null }
    }
    const prior = (await client.query<{ account_hash: string; recovery_key_hash: string; created_at: Date }>("select account_hash,recovery_key_hash,created_at from account_deletion_withdrawals where id=$1",[recovery.requestId])).rows[0]
    if (prior) {
      if (prior.account_hash !== ownerHash || prior.recovery_key_hash !== recoveryHash) throw mismatch()
      await client.query("commit"); return { ...base, outcome: "withdrawn", withdrawnAt: prior.created_at.toISOString() }
    }
    await assertAccountActive(client,scope.accountId)
    if (!(await client.query("select 1 from users where id=$1",[scope.accountId])).rowCount) throw new AccountDeletionError("Your account is no longer available.",404,"account_unavailable")
    const saved = (await client.query<{ created_at: Date }>(`insert into account_deletion_withdrawals(id,account_hash,recovery_key_hash) values($1,$2,$3) returning created_at`,[recovery.requestId,ownerHash,recoveryHash])).rows[0]
    await client.query("commit")
    return { ...base, outcome: "withdrawn", withdrawnAt: saved.created_at.toISOString() }
  } catch (error) {
    await client.query("rollback")
    if ((error as { code?: string })?.code === "P7603") throw mismatch()
    throw accountAccessDatabaseError(error) ?? error
  } finally { client.release() }
}
