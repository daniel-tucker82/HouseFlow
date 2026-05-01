export type AppRole = "manager" | "supervisor" | "member" | "leader"
export type RoutineType = "recurring" | "one_off"
export type TaskStatus = "locked" | "unlocked" | "completed"
export type OccurrenceStatus = "active" | "completed" | "cancelled"

export interface Household {
  id: string
  name: string
  leader_id: string
  timezone?: string
}

export interface Membership {
  household_id: string
  user_id: string
  role: AppRole
}

export interface Routine {
  id: string
  household_id: string
  name: string
  type: RoutineType
  recurrence_rule: string | null
  complete_older_occurrences_on_new: boolean
}

export interface Task {
  id: string
  household_id: string
  routine_id: string | null
  /** Set when this row is a point-in-time copy for a specific occurrence; null for template tasks. */
  routine_occurrence_id?: string | null
  assignee_id: string | null
  title: string
  description?: string | null
  is_reward: boolean
  status: TaskStatus
  position_x?: number | null
  position_y?: number | null
  assignee_ids?: string[]
  scheduled_time: string | null
  unlock_rule?: Record<string, unknown> | null
  unlock_at?: string | null
  unlock_combiner?: "and" | "or"
  expiry_rule?: Record<string, unknown> | null
  expires_at?: string | null
}

export interface RoutineOccurrence {
  id: string
  routine_id: string | null
  household_id?: string
  kind?: "routine" | "manual"
  title?: string | null
  scheduled_for: string
  status: OccurrenceStatus
  total_tasks: number
  completed_tasks: number
}
