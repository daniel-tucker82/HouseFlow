import { normalizeRecurrenceRule, parseRoutineRecurrenceRules, type RecurrenceRule } from "../lib/recurrence"
import type { Routine } from "../lib/types"
import { isCalendarDate, isClockTime } from "./scheduling"

export type EditableRecurrenceRule = Omit<RecurrenceRule, "lastGeneratedAt">
export interface RoutineSchedule { rules: EditableRecurrenceRule[]; completeOlderOccurrencesOnNew: boolean }
export interface RoutineScheduleDraft {
  routineId: string; routineName: string; baseSchedule: RoutineSchedule; schedule: RoutineSchedule;
  /** Replaces only an explicitly rejected request, atomically with the new save. */
  replacesId?: string
}
export const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const
export const monthlyOrdinals = ["1st", "2nd", "3rd", "4th", "last"] as const
export const scheduleLimits = { rules: 100, interval: 36500 } as const

function integer(value: unknown, min: number, max: number, label: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`)
}
export function validateRoutineSchedule(value: unknown): asserts value is RoutineSchedule {
  if (!value || typeof value !== "object") throw new Error("Choose a valid routine schedule.")
  const schedule = value as RoutineSchedule
  if (typeof schedule.completeOlderOccurrencesOnNew !== "boolean" || !Array.isArray(schedule.rules) || schedule.rules.length > scheduleLimits.rules) throw new Error("Choose valid schedule settings and at most 100 recurrence rules.")
  const ids = new Set<string>()
  for (const rule of schedule.rules) {
    if (!rule || typeof rule !== "object" || typeof rule.id !== "string" || !rule.id.trim() || rule.id.length > 200 || ids.has(rule.id)) throw new Error("Each recurrence needs its own identifier.")
    ids.add(rule.id)
    if (Object.hasOwn(rule, "lastGeneratedAt")) throw new Error("Generation history is managed by Cyntch.")
    if (!["daily", "weekly", "monthly", "yearly"].includes(rule.frequency)) throw new Error("Choose a recurrence frequency.")
    integer(rule.interval, 1, scheduleLimits.interval, "Repeat interval")
    if (!isClockTime(rule.time)) throw new Error("Choose a valid recurrence time.")
    if (rule.startDate !== undefined && !isCalendarDate(rule.startDate)) throw new Error("Choose a valid recurrence start date.")
    const monthNth = rule.frequency === "monthly" && rule.monthlyMode === "nth"
    const yearNth = rule.frequency === "yearly" && rule.yearlyMode === "nth"
    if ((rule.frequency === "weekly" || monthNth || yearNth) && !weekdays.includes(rule.weekday!)) throw new Error("Choose a weekday.")
    if (rule.frequency === "monthly") {
      if (rule.monthlyMode !== "nth" && rule.monthlyMode !== "specific_date") throw new Error("Choose how this monthly schedule repeats.")
      if (monthNth) { if (!monthlyOrdinals.includes(rule.nth as typeof monthlyOrdinals[number])) throw new Error("Choose a weekday occurrence from first to fourth, or last.") }
      else integer(rule.dayOfMonth, 1, 31, "Day of month")
    }
    if (rule.frequency === "yearly") {
      if (rule.yearlyMode !== "nth" && rule.yearlyMode !== "specific_date") throw new Error("Choose how this yearly schedule repeats.")
      if (yearNth) {
        if (rule.nth !== "last" && (typeof rule.nth !== "string" || !/^([1-9]|[1-4]\d|5[0-2])th$/.test(rule.nth))) throw new Error("Choose a weekday occurrence from 1 to 52, or last.")
      } else { integer(rule.month, 1, 12, "Month"); integer(rule.day, 1, 31, "Day of month") }
    }
  }
}
export function editableRecurrence(rule: RecurrenceRule): EditableRecurrenceRule {
  const editable = { ...normalizeRecurrenceRule(rule) }
  delete editable.lastGeneratedAt
  return editable
}
export function scheduleForRoutine(routine: Pick<Routine, "recurrence_rule" | "complete_older_occurrences_on_new">): RoutineSchedule {
  return { rules: parseRoutineRecurrenceRules(routine.recurrence_rule).map(editableRecurrence), completeOlderOccurrencesOnNew: routine.complete_older_occurrences_on_new === true }
}
function ruleKey(rule: EditableRecurrenceRule) { return JSON.stringify(editableRecurrence(rule)) }
export function sameRoutineSchedule(left: RoutineSchedule, right: RoutineSchedule) {
  const key = (schedule: RoutineSchedule) => JSON.stringify({ complete: schedule.completeOlderOccurrencesOnNew,
    rules: schedule.rules.map(ruleKey).sort() })
  return key(left) === key(right)
}
export function onlyReducesAutomation(current: RoutineSchedule, desired: RoutineSchedule) {
  return (!desired.completeOlderOccurrencesOnNew || current.completeOlderOccurrencesOnNew) &&
    desired.rules.every(rule => current.rules.some(existing => ruleKey(existing) === ruleKey(rule)))
}
