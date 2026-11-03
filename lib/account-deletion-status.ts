import { createHash } from "node:crypto"
import type { Pool } from "pg"
import { validAccountDeletionRecovery, type AccountDeletionRecovery, type AccountDeletionStatus } from "@/shared/mobile/account-deletion"

export class AccountDeletionStatusError extends Error {
  constructor(public status: 404 | 429) {
    super(status === 429 ? "Please wait a minute before checking deletion again." : "This deletion status is not available with the saved recovery key.")
  }
}
export const accountDeletionRecoveryHash = (secret: string) => createHash("sha256").update(`cyntch-deletion-status-v1:${secret}`).digest("hex")

/** A read-only capability, separate from deleted Clerk sessions/installations.
 * Invalid credentials never create rate-limit rows or expose request existence.
 * Completion receipts are available for 90 days; pending recovery doesn't expire.
 * This does not run cleanup, change its scope, or recreate an identity. */
export async function readAccountDeletionStatus(pool: Pool, recovery: AccountDeletionRecovery): Promise<AccountDeletionStatus> {
  if (!validAccountDeletionRecovery(recovery)) throw new AccountDeletionStatusError(404)
  const result = await pool.query<{ id: string; state: "pending" | "completed"; created_at: Date; completed_at: Date | null;
    apple_revocation_required: boolean; available_until: Date | null; allowed: boolean }>(`with matched as (
      select id,state,created_at,completed_at,apple_revocation_required,completed_at+interval '90 days' as available_until
      from account_deletion_requests where id=$1::uuid and recovery_key_hash=$2
        and (state='pending' or completed_at>clock_timestamp()-interval '90 days')
    ), allowed as (
      insert into application_rate_limits(bucket_key,window_start,requests)
        select 'deletion-status:'||id::text,date_trunc('minute',now()),1 from matched
      on conflict(bucket_key,window_start) do update set requests=application_rate_limits.requests+1 where application_rate_limits.requests<30
      returning requests
    ) select matched.*,exists(select 1 from allowed) as allowed from matched`, [recovery.requestId, accountDeletionRecoveryHash(recovery.secret)])
  const row = result.rows[0]
  if (!row) throw new AccountDeletionStatusError(404)
  if (!row.allowed) throw new AccountDeletionStatusError(429)
  return { requestId: row.id, state: row.state, acceptedAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
    appleRevocationRequired: row.apple_revocation_required, availableUntil: row.available_until?.toISOString() ?? null }
}
