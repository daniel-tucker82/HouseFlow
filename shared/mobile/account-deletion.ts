import type { MemberRole } from "./contracts"

export interface AccountDeletionScope { accountId: string; sessionId: string; deviceId: string }
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
