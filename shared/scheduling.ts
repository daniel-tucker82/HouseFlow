import type { ExpiryRule, UnlockRule } from "../lib/time-rules"
import type { Task } from "../lib/types"

export interface TaskTiming { unlockRule: UnlockRule | null; expiryRule: ExpiryRule | null; unlockCombiner: "and" | "or" }
export const durationLimits = { minutes: 52560000, hours: 876000, days: 36500 } as const

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
export function isClockTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}
function integer(value: unknown, minimum: number, maximum: number, label: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}.`)
}
function validateTimeRule(input: unknown, expiry: boolean) {
  if (input === null) return
  if (!input || typeof input !== "object") throw new Error("Choose a valid time rule.")
  const rule = input as Record<string, unknown>
  if (rule.kind === "none") return
  if (rule.time != null && !isClockTime(rule.time)) throw new Error("Choose a valid time.")
  switch (rule.kind) {
    case "fixed": if (!isCalendarDate(rule.date)) throw new Error("Choose a valid calendar date."); break
    case "after_generation_days": integer(rule.days, 0, 36500, "Days"); break
    case "weekday_after_generation":
    case "weekday_after_unlock":
      if (rule.kind === "weekday_after_unlock" && !expiry) throw new Error("Choose a valid activation rule.")
      integer(rule.weekday, 0, 6, "Weekday"); integer(rule.nth, 1, 5200, "Occurrence"); break
    case "month_day_after_generation":
    case "month_day_after_unlock":
      if (rule.kind === "month_day_after_unlock" && !expiry) throw new Error("Choose a valid activation rule.")
      integer(rule.dayOfMonth, 1, 31, "Day of month"); break
    case "after_creation":
    case "after_unlock":
      if (!expiry) throw new Error("Choose a valid activation rule.")
      if (typeof rule.unit !== "string" || !["minutes", "hours", "days"].includes(rule.unit)) throw new Error("Choose minutes, hours or days.")
      integer(rule.amount, 0, durationLimits[rule.unit as keyof typeof durationLimits], "Duration")
      break
    default: throw new Error("Choose a valid time rule.")
  }
}
export function validateTaskTiming(input: unknown): asserts input is TaskTiming {
  if (!input || typeof input !== "object") throw new Error("Choose valid task timing.")
  const timing = input as TaskTiming
  if (!["and", "or"].includes(timing.unlockCombiner)) throw new Error("Choose how prerequisites and time work together.")
  validateTimeRule(timing.unlockRule, false); validateTimeRule(timing.expiryRule, true)
}
export function timingForTask(task?: Task): TaskTiming {
  return { unlockRule: (task?.unlock_rule as UnlockRule | null) ?? null, expiryRule: (task?.expiry_rule as ExpiryRule | null) ?? null,
    unlockCombiner: task?.unlock_combiner === "or" ? "or" : "and" }
}
