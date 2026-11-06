import type { Pool, PoolClient } from "pg"
import { withActiveAccountTransaction } from "@/lib/account-access"
import { termsUrl, termsVersion, type TermsStatus } from "@/shared/terms-consent"

export const termsAcceptanceRequired = () => process.env.TERMS_ACCEPTANCE_REQUIRED === "true"
export class TermsConsentError extends Error {
  constructor(message = "Review and accept the Terms of use before creating or editing shared content.", public status = 428) { super(message) }
}
type Query = Pick<PoolClient, "query">
export async function termsStatus(db: Query, accountId: string): Promise<TermsStatus> {
  const required = termsAcceptanceRequired()
  const row = required ? (await db.query<{ accepted_at: Date }>("select accepted_at from terms_acceptances where user_id=$1 and version=$2", [accountId, termsVersion])).rows[0] : undefined
  return { accountId, required, version: termsVersion, url: termsUrl, acceptedAt: row?.accepted_at.toISOString() ?? null }
}
export async function requireTermsAcceptance(db: Query, accountId: string) {
  if (termsAcceptanceRequired() && !(await termsStatus(db, accountId)).acceptedAt) throw new TermsConsentError()
}
export async function acceptTerms(db: Pool, accountId: string, input: unknown): Promise<TermsStatus> {
  const value = input as { accountId?: unknown; version?: unknown; agree?: unknown } | null
  if (!termsAcceptanceRequired()) throw new TermsConsentError("Terms acceptance is not enabled on this service.", 404)
  if (value?.accountId !== accountId) throw new TermsConsentError("Your account changed. Review the terms for this sign-in.", 403)
  if (!value || value.agree !== true || value.version !== termsVersion) throw new TermsConsentError("Read the current terms and explicitly choose to agree.", 400)
  return withActiveAccountTransaction(db, accountId, async client => {
    await client.query("insert into terms_acceptances(user_id,version) values($1,$2) on conflict do nothing", [accountId, termsVersion])
    return termsStatus(client, accountId)
  })
}

// Completion/reopening, reads, removal and reporting never require another
// agreement. This check adds no call to the offline completion save path.
export const sharedContentActions = new Set(["createHousehold", "createRoutine", "renameRoutine", "createHouseholdMember", "renameHouseholdMember",
  "createTaskBoard", "renameTaskBoard", "createOccurrence", "createTask", "updateTask"])
