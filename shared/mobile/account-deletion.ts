import type { MemberRole } from "./contracts"
import { notificationUuid, notificationSessionId } from "./notification-settings"

export interface AccountDeletionRecovery { requestId: string; secret: string }
/** Elapsed time, independent of the database connection's timezone or DST. */
export const ACCOUNT_DELETION_RECEIPT_LIFETIME_MS = 90 * 86_400_000
export function accountDeletionOrigin(value: string, allowDevelopmentHttp = false): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error("Cyntch requires a valid server address.") }
  const local = allowDevelopmentHttp && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(url.hostname)
  if ((url.protocol !== "https:" && !local) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Cyntch requires a secure server address without credentials or a path.")
  }
  return url.origin
}
/** Safe after sign-out: no account, household, provider or worker identifiers. */
export interface AccountDeletionStatus {
  requestId: string
  state: "pending" | "completed"
  acceptedAt: string
  completedAt: string | null
  appleRevocationRequired: boolean
  availableUntil: string | null
}
export function validAccountDeletionRecovery(value: unknown): value is AccountDeletionRecovery {
  const row = value as Partial<AccountDeletionRecovery> | null
  return Boolean(row && typeof row === "object" && !Array.isArray(row) && typeof row.requestId === "string" && notificationUuid.test(row.requestId) &&
    row.requestId === row.requestId.toLowerCase() && typeof row.secret === "string" && /^[a-f0-9]{64}$/.test(row.secret))
}
export function parseAccountDeletionStatus(value: unknown, requestId: string): AccountDeletionStatus {
  const row = value as Partial<AccountDeletionStatus> | null
  const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
  if (!row || typeof row !== "object" || Array.isArray(row) || !notificationUuid.test(requestId) || row.requestId !== requestId || (row.state !== "pending" && row.state !== "completed") || !date(row.acceptedAt) || typeof row.appleRevocationRequired !== "boolean" ||
    (row.state === "pending" ? row.completedAt !== null || row.availableUntil !== null :
      !date(row.completedAt) || !date(row.availableUntil) || Date.parse(row.completedAt) < Date.parse(row.acceptedAt) || Date.parse(row.availableUntil) <= Date.parse(row.completedAt))) {
    throw new Error("Cyntch returned an invalid account deletion status. Please retry.")
  }
  return { requestId, state: row.state, acceptedAt: row.acceptedAt, completedAt: row.completedAt!, appleRevocationRequired: row.appleRevocationRequired, availableUntil: row.availableUntil! }
}

export interface AccountDeletionScope { accountId: string; sessionId: string; deviceId: string }
export interface AccountDeletionAcceptance extends AccountDeletionScope { status: AccountDeletionStatus }
export function parseAccountDeletionAcceptance(value: unknown, expected: AccountDeletionScope & { requestId: string }): AccountDeletionAcceptance {
  const row = value as Partial<AccountDeletionAcceptance> | null
  if (!row || typeof row !== "object" || Array.isArray(row) || row.accountId !== expected.accountId || row.sessionId !== expected.sessionId || row.deviceId !== expected.deviceId ||
    !/^user_[A-Za-z0-9_-]{1,200}$/.test(expected.accountId) || !notificationSessionId.test(expected.sessionId) || !notificationUuid.test(expected.deviceId)) {
    throw new Error("The deletion reply does not match this account and device. Check its saved status.")
  }
  return { accountId: expected.accountId, sessionId: expected.sessionId, deviceId: expected.deviceId, status: parseAccountDeletionStatus(row.status,expected.requestId) }
}
export type AccountDeletionWithdrawalResult = AccountDeletionScope & { requestId: string } & (
  | { outcome: "withdrawn"; withdrawnAt: string }
  | { outcome: "accepted"; withdrawnAt: null }
)
export function parseAccountDeletionWithdrawal(value: unknown, expected: AccountDeletionScope & { requestId: string }): AccountDeletionWithdrawalResult {
  const row = value as Partial<AccountDeletionWithdrawalResult> | null
  if (!row || typeof row !== "object" || Array.isArray(row) || row.accountId !== expected.accountId || row.sessionId !== expected.sessionId || row.deviceId !== expected.deviceId ||
    row.requestId !== expected.requestId || !/^user_[A-Za-z0-9_-]{1,200}$/.test(expected.accountId) || !notificationSessionId.test(expected.sessionId) || !notificationUuid.test(expected.deviceId) || !notificationUuid.test(expected.requestId) ||
    (row.outcome !== "withdrawn" && row.outcome !== "accepted") ||
    (row.outcome === "accepted" ? row.withdrawnAt !== null : typeof row.withdrawnAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.withdrawnAt) || !Number.isFinite(Date.parse(row.withdrawnAt)) || new Date(row.withdrawnAt).toISOString() !== row.withdrawnAt)) {
    throw new Error("Cyntch returned an invalid withdrawal receipt. Keep the recovery information and retry.")
  }
  const scope = { accountId: expected.accountId, sessionId: expected.sessionId, deviceId: expected.deviceId, requestId: expected.requestId }
  return row.outcome === "accepted" ? { ...scope, outcome: "accepted", withdrawnAt: null } : { ...scope, outcome: "withdrawn", withdrawnAt: row.withdrawnAt! }
}
export interface DeletionContentCounts { routines: number; runs: number; tasks: number }
export interface DeletionBillingSource {
  provider: "stripe" | "app_store" | "play_store"
  environment: "production" | "sandbox" | "unknown"
  status: string
  renewal: string
  pendingPayment: boolean
  accessThrough: string | null
  verifiedAt: string | null
}
export interface AccountDeletionHousehold {
  id: string
  name: string
  role: MemberRole
  owned: boolean
  /** Only an owner may review other members and the whole household's impact. */
  ownership: null | {
    otherAccounts: number
    profilesWithoutSignIn: number
    /** Sign-in-capable managers/supervisors; never a local child profile. */
    possibleSuccessors: { id: string; name: string; role: "manager" | "supervisor" }[]
    content: DeletionContentCounts
    billing: DeletionBillingSource[]
    purchasePending: boolean
  }
}
/** A read-only review, not an accepted deletion request or a provider check. */
export interface AccountDeletionReview extends AccountDeletionScope {
  revision: string
  reviewedAt: string
  households: AccountDeletionHousehold[]
  authoredContent: DeletionContentCounts
  permanentOwnerAccess: boolean
}
export type AccountDeletionOwnershipChoice =
  | { householdId: string; action: "delete" }
  | { householdId: string; action: "transfer"; successorId: string }
export interface AccountDeletionIntent {
  operationId: string
  revision: string
  ownership: AccountDeletionOwnershipChoice[]
  confirmAccountDeletion: true
  acknowledgeSubscriptions: true
}

export class AccountDeletionIntentError extends Error {}
/** Same canonical request on phone and server; only explicitly supported fields
 * survive. This validates shape, not ownership, current sign-in or consent. */
export function normalizeAccountDeletionIntent(value: unknown): AccountDeletionIntent {
  const row = value as Partial<AccountDeletionIntent> | null
  if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.operationId !== "string" || !notificationUuid.test(row.operationId) || typeof row.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.revision) || row.confirmAccountDeletion !== true || row.acknowledgeSubscriptions !== true || !Array.isArray(row.ownership) || row.ownership.length > 100) {
    throw new AccountDeletionIntentError("Review and confirm the account and subscription consequences first.")
  }
  const seen = new Set<string>()
  const ownership: AccountDeletionOwnershipChoice[] = row.ownership.map((choice): AccountDeletionOwnershipChoice => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice) || typeof choice.householdId !== "string" || !notificationUuid.test(choice.householdId) || seen.has(choice.householdId.toLowerCase())) throw new AccountDeletionIntentError("Choose what happens to each household once.")
    const householdId = choice.householdId.toLowerCase(); seen.add(householdId)
    if (choice.action === "delete") return { householdId, action: "delete" }
    if (choice.action === "transfer" && typeof choice.successorId === "string" && /^user_[A-Za-z0-9_-]{1,200}$/.test(choice.successorId)) return { householdId, action: "transfer", successorId: choice.successorId }
    throw new AccountDeletionIntentError("Choose a parent to take over this household, or choose household deletion.")
  }).sort((left, right) => left.householdId.localeCompare(right.householdId))
  return { operationId: row.operationId.toLowerCase(), revision: row.revision, ownership, confirmAccountDeletion: true, acknowledgeSubscriptions: true }
}

export interface AccountDeletionSubmission extends AccountDeletionScope {
  origin: string
  intent: AccountDeletionIntent
}
export function normalizeAccountDeletionSubmission(value: unknown, allowDevelopmentHttp = false): AccountDeletionSubmission {
  const row = value as Partial<AccountDeletionSubmission> | null
  if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.accountId !== "string" || !/^user_[A-Za-z0-9_-]{1,200}$/.test(row.accountId) ||
    typeof row.sessionId !== "string" || !notificationSessionId.test(row.sessionId) || typeof row.deviceId !== "string" || !notificationUuid.test(row.deviceId) || typeof row.origin !== "string") {
    throw new AccountDeletionIntentError("Your sign-in or device changed. Review account deletion again.")
  }
  return { accountId: row.accountId, sessionId: row.sessionId, deviceId: row.deviceId.toLowerCase(), origin: accountDeletionOrigin(row.origin, allowDevelopmentHttp),
    intent: normalizeAccountDeletionIntent(row.intent) }
}
