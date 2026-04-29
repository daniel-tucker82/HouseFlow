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

export function createDefaultRecurrenceRule(): RecurrenceRule {
  return {
    id: crypto.randomUUID(),
    frequency: "weekly",
    interval: 1,
    weekday: "monday",
    time: "09:00",
  }
}

function coercePositiveInt(value: unknown, fallback = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.floor(n))
}

function coerceTime(value: unknown) {
  const text = String(value ?? "").trim()
  return /^\d{2}:\d{2}$/.test(text) ? text : "09:00"
}

function coerceDate(value: unknown) {
  const text = String(value ?? "").trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined
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

function parseDateAndTime(dateText: string, timeText: string) {
  const [year, month, day] = dateText.split("-").map(Number)
  const [hour, minute] = timeText.split(":").map(Number)
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null
  const dt = new Date(year, month - 1, day, hour, minute, 0, 0)
  return Number.isNaN(dt.getTime()) ? null : dt
}

function weekdayToIndex(weekday: Weekday): number {
  return WEEKDAY_VALUES.indexOf(weekday)
}

function nthToIndex(nth: string): number {
  if (nth === "last") return -1
  const parsed = Number(nth.replace("th", ""))
  return Number.isFinite(parsed) ? parsed : 1
}

function monthIndex(year: number, monthZeroBased: number) {
  return year * 12 + monthZeroBased
}

function startOfWeek(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - d.getDay())
  return d
}

function monthlyOccurrenceForMonth(rule: RecurrenceRule, year: number, month: number, hour: number, minute: number): Date {
  if ((rule.monthlyMode ?? "specific_date") === "nth") {
    const weekday = weekdayToIndex(rule.weekday ?? "monday")
    const nth = nthToIndex(String(rule.nth ?? "1st"))
    if (nth === -1) {
      const d = new Date(year, month + 1, 0, hour, minute, 0, 0)
      while (d.getDay() !== weekday) d.setDate(d.getDate() - 1)
      return d
    }
    const d = new Date(year, month, 1, hour, minute, 0, 0)
    while (d.getDay() !== weekday) d.setDate(d.getDate() + 1)
    d.setDate(d.getDate() + (nth - 1) * 7)
    return d
  }
  const day = Math.max(1, rule.dayOfMonth ?? 1)
  const lastDay = new Date(year, month + 1, 0).getDate()
  return new Date(year, month, Math.min(day, lastDay), hour, minute, 0, 0)
}

function yearlyOccurrenceForYear(rule: RecurrenceRule, year: number, hour: number, minute: number): Date {
  if ((rule.yearlyMode ?? "specific_date") === "nth") {
    const weekday = weekdayToIndex(rule.weekday ?? "monday")
    const nth = nthToIndex(String(rule.nth ?? "1th"))
    if (nth === -1) {
      const d = new Date(year, 11, 31, hour, minute, 0, 0)
      while (d.getDay() !== weekday) d.setDate(d.getDate() - 1)
      return d
    }
    const d = new Date(year, 0, 1, hour, minute, 0, 0)
    while (d.getDay() !== weekday) d.setDate(d.getDate() + 1)
    d.setDate(d.getDate() + (nth - 1) * 7)
    return d
  }
  return new Date(year, (rule.month ?? 1) - 1, rule.day ?? 1, hour, minute, 0, 0)
}

export function nextRecurrenceDate(rule: RecurrenceRule, now = new Date()): Date | null {
  const anchorDate = rule.startDate ?? now.toISOString().slice(0, 10)
  const anchor = parseDateAndTime(anchorDate, rule.time)
  if (!anchor) return null
  const interval = Math.max(1, rule.interval)

  if (rule.frequency === "daily") {
    const dayMs = 24 * 60 * 60 * 1000
    let candidate = new Date(anchor)
    if (candidate <= now) {
      const elapsedDays = Math.floor((now.getTime() - anchor.getTime()) / dayMs)
      const jumps = Math.floor(elapsedDays / interval) + 1
      candidate = new Date(anchor)
      candidate.setDate(candidate.getDate() + jumps * interval)
    }
    while (candidate <= now) candidate.setDate(candidate.getDate() + interval)
    return candidate
  }

  if (rule.frequency === "weekly") {
    const weekday = weekdayToIndex(rule.weekday ?? "monday")
    const first = new Date(anchor)
    while (first.getDay() !== weekday) first.setDate(first.getDate() + 1)
    const candidate = new Date(first)
    if (candidate <= now) {
      const weeksDiff = Math.floor(
        (startOfWeek(now).getTime() - startOfWeek(first).getTime()) / (7 * 24 * 60 * 60 * 1000),
      )
      const jumps = Math.floor(Math.max(0, weeksDiff) / interval)
      candidate.setDate(candidate.getDate() + jumps * interval * 7)
      while (candidate <= now) candidate.setDate(candidate.getDate() + interval * 7)
    }
    return candidate
  }

  if (rule.frequency === "monthly") {
    const baseMonth = monthIndex(anchor.getFullYear(), anchor.getMonth())
    let candidateMonth = Math.max(baseMonth, monthIndex(now.getFullYear(), now.getMonth()))
    const rem = (candidateMonth - baseMonth) % interval
    if (rem !== 0) candidateMonth += interval - rem

    let candidate = monthlyOccurrenceForMonth(
      rule,
      Math.floor(candidateMonth / 12),
      candidateMonth % 12,
      anchor.getHours(),
      anchor.getMinutes(),
    )
    if (candidate < anchor || candidate <= now) {
      candidateMonth += interval
      candidate = monthlyOccurrenceForMonth(
        rule,
        Math.floor(candidateMonth / 12),
        candidateMonth % 12,
        anchor.getHours(),
        anchor.getMinutes(),
      )
      while (candidate <= now) {
        candidateMonth += interval
        candidate = monthlyOccurrenceForMonth(
          rule,
          Math.floor(candidateMonth / 12),
          candidateMonth % 12,
          anchor.getHours(),
          anchor.getMinutes(),
        )
      }
    }
    return candidate
  }

  const baseYear = anchor.getFullYear()
  let year = Math.max(baseYear, now.getFullYear())
  const sinceBase = year - baseYear
  const rem = sinceBase % interval
  if (rem !== 0) year += interval - rem

  let candidate = yearlyOccurrenceForYear(rule, year, anchor.getHours(), anchor.getMinutes())
  if (candidate <= now) {
    year += interval
    candidate = yearlyOccurrenceForYear(rule, year, anchor.getHours(), anchor.getMinutes())
  }
  return candidate
}

export function latestRecurrenceAtOrBefore(rule: RecurrenceRule, now = new Date()): Date | null {
  const next = nextRecurrenceDate(rule, now)
  if (!next) return null
  const anchorDate = rule.startDate ?? now.toISOString().slice(0, 10)
  const anchor = parseDateAndTime(anchorDate, rule.time)
  if (!anchor) return null
  const interval = Math.max(1, rule.interval)

  if (rule.frequency === "daily") {
    const prev = new Date(next)
    prev.setDate(prev.getDate() - interval)
    return prev >= anchor ? prev : null
  }

  if (rule.frequency === "weekly") {
    const prev = new Date(next)
    prev.setDate(prev.getDate() - interval * 7)
    return prev >= anchor ? prev : null
  }

  if (rule.frequency === "monthly") {
    const candidateMonth = monthIndex(next.getFullYear(), next.getMonth()) - interval
    if (candidateMonth < monthIndex(anchor.getFullYear(), anchor.getMonth())) return null
    const prev = monthlyOccurrenceForMonth(
      rule,
      Math.floor(candidateMonth / 12),
      candidateMonth % 12,
      anchor.getHours(),
      anchor.getMinutes(),
    )
    return prev >= anchor ? prev : null
  }

  const prevYear = next.getFullYear() - interval
  if (prevYear < anchor.getFullYear()) return null
  const prev = yearlyOccurrenceForYear(rule, prevYear, anchor.getHours(), anchor.getMinutes())
  return prev >= anchor ? prev : null
}
