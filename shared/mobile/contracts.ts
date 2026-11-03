export type MemberRole = "manager" | "supervisor" | "member"
export type TaskState = "locked" | "unlocked" | "completed"

export interface HouseholdSummary {
  id: string
  name: string
  timezone: string
  leaderId: string
  role: MemberRole
}

export interface HouseholdMember {
  id: string
  name: string
  avatar_url: string | null
  token_color: string | null
  role: MemberRole
}

export interface BoardTask {
  id: string
  occurrence_id: string
  occurrence_title: string | null
  occurrence_kind: "routine" | "manual"
  title: string
  description: string | null
  is_reward: boolean
  status: TaskState
  /** Decimal server revision; absent only in caches/responses from older releases. */
  status_version?: string
  assignee_ids: string[]
  lock_type: "none" | "prerequisite" | "time"
  blocking_task_title: string | null
  blocking_task_id?: string | null
  blocking_task_assignee_ids?: string[]
  unlock_at: string | null
  expires_at: string | null
}

export interface BoardSnapshot {
  household: HouseholdSummary
  members: HouseholdMember[]
  tasks: BoardTask[]
  fetchedAt: string
}

export interface CompletionChange {
  id: string
  accountId: string
  householdId: string
  deviceId: string
  taskId: string
  occurrenceId: string
  memberId: string
  completed: boolean
  deviceTimeMs: number
  sequence: number
  correctedTimeMs: number | null
  attempts: number
  nextAttemptMs: number
  state: "pending" | "rejected"
  error: string | null
}

export interface CompletionResult {
  operationId: string
  outcome: "applied" | "superseded" | "rejected"
  error?: string
  occurrenceTaskStatuses: { task_id: string; status: TaskState; status_version?: string }[]
}

export interface CompletionVersion {
  operationId: string
  deviceId: string
  sequence: number
  correctedTimeMs: number
}
