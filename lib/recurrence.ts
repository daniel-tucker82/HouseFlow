import { isCalendarDate, isClockTime } from "../shared/scheduling"
import { convertUtcWallClockToTimeZoneInstant, householdWallClock } from "./time-rules"

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly"
export type Weekday = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday"
export type MonthlyMode = "specific_date" | "nth"
export type YearlyMode = "specific_date" | "nth"
export type MonthlyNth = "1st" | "2nd" | "3rd" | "4th" | "last"
export type YearlyNth = `${number}th` | "last"

export type RecurrenceRule = {
  id: string
  frequency: RecurrenceFrequency
  interval: number
  time: string
  startDate?: string
  lastGeneratedAt?: string
  weekday?: Weekday
  monthlyMode?: MonthlyMode
  yearlyMode?: YearlyMode
  dayOfMonth?: number
  nth?: MonthlyNth | YearlyNth
  month?: number
  day?: number
}

const WEEKDAY_VALUES: Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]
const MONTHLY_NTH_VALUES: MonthlyNth[] = ["1st", "2nd", "3rd", "4th", "last"]

export function createDefaultRecurrenceRule(timeZone = "UTC", now = new Date()): RecurrenceRule {
  return {
    id: crypto.randomUUID(),
    frequency: "weekly",
    interval: 1,
    weekday: "monday",
    time: "09:00",
    startDate: householdWallClock(now, timeZone).toISOString().slice(0, 10),
  }
}

function coercePositiveInt(value: unknown, fallback = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.floor(n))
}

function coerceTime(value: unknown) {
  const text = String(value ?? "").trim()
  return isClockTime(text) ? text : "09:00"
}

function coerceDate(value: unknown) {
  const text = String(value ?? "").trim()
  return isCalendarDate(text) ? text : undefined
}

function coerceIsoDateTime(value: unknown) {
  const text = String(value ?? "").trim()
  if (!text) return undefined
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

export function normalizeRecurrenceRule(input: unknown): RecurrenceRule {
  const source = (input ?? {}) as Record<string, unknown>
  const frequency = String(source.frequency ?? "weekly").toLowerCase() as RecurrenceFrequency
  const base: RecurrenceRule = {
    id: typeof source.id === "string" && source.id ? source.id : crypto.randomUUID(),
    frequency: ["daily", "weekly", "monthly", "yearly"].includes(frequency) ? frequency : "weekly",
    interval: coercePositiveInt(source.interval, 1),
    time: coerceTime(source.time),
    startDate: coerceDate(source.startDate),
    lastGeneratedAt: coerceIsoDateTime(source.lastGeneratedAt),
  }

  if (base.frequency === "weekly") {
    base.weekday = WEEKDAY_VALUES.includes(source.weekday as Weekday) ? (source.weekday as Weekday) : "monday"
    return base
  }

  if (base.frequency === "monthly") {
    const mode = source.monthlyMode === "nth" ? "nth" : "specific_date"
    base.monthlyMode = mode
    if (mode === "specific_date") {
      base.dayOfMonth = Math.min(31, Math.max(1, coercePositiveInt(source.dayOfMonth, 1)))
    } else {
      base.nth = MONTHLY_NTH_VALUES.includes(source.nth as MonthlyNth) ? (source.nth as MonthlyNth) : "1st"
      base.weekday = WEEKDAY_VALUES.includes(source.weekday as Weekday) ? (source.weekday as Weekday) : "monday"
    }
    return base
  }

  if (base.frequency === "yearly") {
    const mode = source.yearlyMode === "nth" ? "nth" : "specific_date"
    base.yearlyMode = mode
    if (mode === "specific_date") {
      const month = Number(source.month)
      const day = Number(source.day)
      base.month = Number.isFinite(month) ? Math.min(12, Math.max(1, Math.floor(month))) : 1
      base.day = Number.isFinite(day) ? Math.min(31, Math.max(1, Math.floor(day))) : 1
    } else {
      const nthRaw = String(source.nth ?? "1th").toLowerCase()
      if (nthRaw === "last") {
        base.nth = "last"
      } else {
        const match = nthRaw.match(/^(\d{1,2})th$/)
        const nthNumber = match ? Number(match[1]) : 1
        base.nth = `${Math.min(52, Math.max(1, nthNumber))}th`
      }
      base.weekday = WEEKDAY_VALUES.includes(source.weekday as Weekday) ? (source.weekday as Weekday) : "monday"
    }
    return base
  }

  return base
}

export function parseRoutineRecurrenceRules(raw: string | null | undefined): RecurrenceRule[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => normalizeRecurrenceRule(item))
  } catch {
    return []
  }
}

export function serializeRoutineRecurrenceRules(rules: RecurrenceRule[]): string {
  return JSON.stringify(rules.map((rule) => normalizeRecurrenceRule(rule)))
}

export function recurrenceRuleSummary(rule: RecurrenceRule): string {
  if (rule.frequency === "daily") return `Every ${rule.interval} day(s) at ${rule.time}`
  if (rule.frequency === "weekly") return `Every ${rule.interval} week(s) on ${rule.weekday} at ${rule.time}`
  if (rule.frequency === "monthly") {
    if (rule.monthlyMode === "nth") return `Every ${rule.interval} month(s) on ${rule.nth} ${rule.weekday} at ${rule.time}`
    return `Every ${rule.interval} month(s) on day ${rule.dayOfMonth ?? 1} at ${rule.time}`
  }
  if (rule.yearlyMode === "nth") return `Every ${rule.interval} year(s) on ${rule.nth} ${rule.weekday} at ${rule.time}`
  return `Every ${rule.interval} year(s) on ${rule.month ?? 1}/${rule.day ?? 1} at ${rule.time}`
}

/** Give legacy rules a stable calendar anchor without inventing historical runs.
 * A previous generated slot preserves its interval phase; otherwise begin today.
 * Persist the returned rule in the same transaction as scheduler watermarks.
 */
export function anchorRecurrenceRule(rule: RecurrenceRule, now: Date, timeZone: string): RecurrenceRule {
  if (isCalendarDate(rule.startDate)) return rule
  const generated = rule.lastGeneratedAt ? new Date(rule.lastGeneratedAt) : null
  const reference = generated && Number.isFinite(generated.getTime()) ? generated : now
  return { ...rule, startDate: householdWallClock(reference, timeZone).toISOString().slice(0, 10) }
}

function calendarDate(year: number, month: number, day: number, hour = 0, minute = 0) {
  const result = new Date(0)
  result.setUTCFullYear(year, month, day)
  result.setUTCHours(hour, minute, 0, 0)
  return result
}
function monthIndex(date: Date) { return date.getUTCFullYear() * 12 + date.getUTCMonth() }
function addDays(date: Date, days: number) {
  const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result
}
function nthWeekday(first: Date, last: Date, weekday: Weekday, nth: string) {
  const wanted = WEEKDAY_VALUES.indexOf(weekday)
  if (nth === "last") return addDays(last, -((last.getUTCDay() - wanted + 7) % 7))
  const ordinal = Number.parseInt(nth, 10) // accepts 1st, 2nd, 3rd, 4th and yearly 1th..52th
  return addDays(first, (wanted - first.getUTCDay() + 7) % 7 + (ordinal - 1) * 7)
}
function monthlySlot(rule: RecurrenceRule, month: number, hour: number, minute: number) {
  const year = Math.floor(month / 12), inYear = month % 12
  const last = calendarDate(year, inYear + 1, 0, hour, minute)
  if (rule.monthlyMode === "nth") return nthWeekday(calendarDate(year, inYear, 1, hour, minute), last, rule.weekday ?? "monday", String(rule.nth ?? "1st"))
  return calendarDate(year, inYear, Math.min(rule.dayOfMonth ?? 1, last.getUTCDate()), hour, minute)
}
function yearlySlot(rule: RecurrenceRule, year: number, hour: number, minute: number) {
  if (rule.yearlyMode === "nth") return nthWeekday(calendarDate(year, 0, 1, hour, minute), calendarDate(year, 11, 31, hour, minute), rule.weekday ?? "monday", String(rule.nth ?? "1th"))
  const month = (rule.month ?? 1) - 1
  // Match monthly rules: dates absent in a shorter month use its final day.
  return calendarDate(year, month, Math.min(rule.day ?? 1, calendarDate(year, month + 1, 0).getUTCDate()), hour, minute)
}

/** Calendar slots use UTC fields only as wall-clock coordinates, then resolve
 * once in the household zone. Compare actual instants, including DST gaps/folds.
 * Jump directly to the current interval; never loop over years of missed runs.
 */
function recurrenceWindow(rule: RecurrenceRule, now: Date, timeZone: string) {
  const empty = { previous: null as Date | null, next: null as Date | null }
  if (!Number.isFinite(now.getTime()) || !isClockTime(rule.time) || !Number.isSafeInteger(rule.interval) || rule.interval < 1 ||
    (rule.startDate !== undefined && !isCalendarDate(rule.startDate))) return empty
  const anchored = anchorRecurrenceRule(rule, now, timeZone)
  const anchor = new Date(anchored.startDate + "T" + rule.time + ":00Z")
  const wallNow = householdWallClock(now, timeZone), interval = rule.interval
  const hour = anchor.getUTCHours(), minute = anchor.getUTCMinutes()
  let approximate: number, slot: (index: number) => Date
  if (rule.frequency === "daily" || rule.frequency === "weekly") {
    const first = rule.frequency === "weekly"
      ? addDays(anchor, (WEEKDAY_VALUES.indexOf(rule.weekday ?? "monday") - anchor.getUTCDay() + 7) % 7) : anchor
    const days = interval * (rule.frequency === "weekly" ? 7 : 1)
    approximate = Math.floor((wallNow.getTime() - first.getTime()) / (86400000 * days))
    slot = index => addDays(first, index * days)
  } else if (rule.frequency === "monthly") {
    const baseMonth = monthIndex(anchor)
    approximate = Math.floor((monthIndex(wallNow) - baseMonth) / interval)
    slot = index => monthlySlot(rule, baseMonth + index * interval, hour, minute)
  } else if (rule.frequency === "yearly") {
    const baseYear = anchor.getUTCFullYear()
    approximate = Math.floor((wallNow.getUTCFullYear() - baseYear) / interval)
    slot = index => yearlySlot(rule, baseYear + index * interval, hour, minute)
  } else return empty

  approximate = Math.max(0, approximate)
  const result = { ...empty }
  // Adjacent slots cover month boundaries and even a skipped calendar day.
  for (let index = Math.max(0, approximate - 2); index <= approximate + 2; index++) {
    const wall = slot(index)
    if (!Number.isFinite(wall.getTime()) || wall < anchor || wall.getUTCFullYear() > 9999) continue
    const instant = convertUtcWallClockToTimeZoneInstant(wall, timeZone)
    if (instant <= now && (!result.previous || instant > result.previous)) result.previous = instant
    if (instant > now && (!result.next || instant < result.next)) result.next = instant
  }
  return result
}

export function nextRecurrenceDate(rule: RecurrenceRule, now = new Date(), timeZone = "UTC"): Date | null {
  return recurrenceWindow(rule, now, timeZone).next
}

export function latestRecurrenceAtOrBefore(rule: RecurrenceRule, now = new Date(), timeZone = "UTC"): Date | null {
  return recurrenceWindow(rule, now, timeZone).previous
}
