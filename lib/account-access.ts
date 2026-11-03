import { createHash } from "node:crypto"
import type { Pool, PoolClient } from "pg"

export const accountAccessKey = (accountId: string) => `account-deletion:${accountId}`
export const accountHash = (accountId: string) => createHash("sha256").update(accountId).digest("hex")
export class AccountAccessError extends Error {
  constructor(public status = 410, public code = "account_deletion_pending") {
    super(status === 429 ? "Account access is changing. Please try again." : "Account deletion has been requested. This account can no longer change household data.")
  }
}
export async function assertAccountActive(client: Pick<PoolClient,"query">, accountId: string) {
  if ((await client.query("select 1 from account_deletion_requests where account_hash=$1",[accountHash(accountId)])).rowCount) throw new AccountAccessError()
}
export function accountAccessDatabaseError(error: unknown) {
  const code = (error as {code?: string} | null)?.code
  return code === "P7601" ? new AccountAccessError() : code === "P7602" ? new AccountAccessError(429,"account_access_changing") : null
}

/** Call inside a transaction, before household locks. The database function
 * keeps a shared account lock until that transaction commits or rolls back. */
export async function lockActiveAccount(client: Pick<PoolClient,"query">, accountId: string) {
  try { await client.query("select cyntch_require_active_account($1)",[accountId]) }
  catch (error) { throw accountAccessDatabaseError(error) ?? error }
}

/** All reads/validation and writes in work use this client. */
export async function withActiveAccountTransaction<T>(pool: Pool, accountId: string, work: (client: PoolClient) => Promise<T>) {
  const client=await pool.connect()
  try {
    await client.query("begin")
    await client.query("set local lock_timeout='2s'")
    await lockActiveAccount(client,accountId)
    const result=await work(client)
    await client.query("commit")
    return result
  } catch(error) {await client.query("rollback");throw error} finally {client.release()}
}

/** Admission for a server action spanning multiple queries/transactions. Use
 * the separate admission pool, not the pool needed by work's own queries. */
export async function withActiveAccount<T>(pool: Pool, accountId: string, work: () => Promise<T>): Promise<T> {
  const client=await pool.connect(),key=accountAccessKey(accountId)
  let locked=false
  try {
    locked=(await client.query<{locked:boolean}>("select pg_try_advisory_lock_shared(hashtextextended($1,0)) as locked",[key])).rows[0].locked
    if(!locked) throw new AccountAccessError(429,"account_access_changing")
    await assertAccountActive(client,accountId)
    return await work()
  } finally {
    try {
      if(locked) await client.query("select pg_advisory_unlock_shared(hashtextextended($1,0))",[key])
      client.release()
    } catch { client.release(true) }
  }
}
