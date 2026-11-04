import type { AccountDeletionReview, AccountDeletionScope } from "../../../shared/mobile/account-deletion"
import { notificationUuid } from "../../../shared/mobile/notification-settings"

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const counts = (value: unknown) => object(value) && count(value.routines) && count(value.runs) && count(value.tasks)
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value))
const optionalDate = (value: unknown) => value === null || date(value)

/** A partial review must never become a destructive consent screen. Identity
 * binding alone does not establish complete household or billing disclosure. */
export function parseAccountDeletionReview(value: unknown, scope: AccountDeletionScope): AccountDeletionReview {
  const invalid = () => new Error("Cyntch returned an incomplete account review. Please refresh before continuing.")
  if (!object(value) || value.accountId !== scope.accountId || value.sessionId !== scope.sessionId || value.deviceId !== scope.deviceId) {
    throw new Error("This account review belongs to a different account, device or sign-in. Reopen account settings.")
  }
  if (typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || !date(value.reviewedAt) || !counts(value.authoredContent) ||
    typeof value.permanentOwnerAccess !== "boolean" || !Array.isArray(value.households)) throw invalid()
  const households = new Set<string>()
  for (const household of value.households) {
    if (!object(household) || typeof household.id !== "string" || !notificationUuid.test(household.id) || households.has(household.id.toLowerCase()) ||
      !text(household.name) || !["manager","supervisor","member"].includes(String(household.role)) || typeof household.owned !== "boolean") throw invalid()
    households.add(household.id.toLowerCase())
    const ownership = household.ownership
    if (!household.owned) { if (ownership !== null) throw invalid();continue }
    if (!object(ownership) || !count(ownership.otherAccounts) || !count(ownership.profilesWithoutSignIn) || !counts(ownership.content) ||
      typeof ownership.purchasePending !== "boolean" || !Array.isArray(ownership.possibleSuccessors) || !Array.isArray(ownership.billing)) throw invalid()
    const successors = new Set<string>()
    for (const successor of ownership.possibleSuccessors) {
      if (!object(successor) || typeof successor.id !== "string" || !/^user_[A-Za-z0-9_-]{1,200}$/.test(successor.id) || successor.id === scope.accountId ||
        successors.has(successor.id) || !text(successor.name) || !["manager","supervisor"].includes(String(successor.role))) throw invalid()
      successors.add(successor.id)
    }
    if (successors.size > Number(ownership.otherAccounts)) throw invalid()
    for (const source of ownership.billing) {
      if (!object(source) || !["stripe","app_store","play_store"].includes(String(source.provider)) || !["production","sandbox","unknown"].includes(String(source.environment)) ||
        !text(source.status) || !text(source.renewal) || typeof source.pendingPayment !== "boolean" || !optionalDate(source.accessThrough) || !optionalDate(source.verifiedAt)) throw invalid()
    }
  }
  return value as unknown as AccountDeletionReview
}
