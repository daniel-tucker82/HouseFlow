export type UnlockCombiner = "and" | "or"

export type UnlockRule =
  | { kind: "none" }
  | { kind: "fixed"; date: string; time?: string | null }
  | { kind: "after_generation_days"; days: number; time?: string | null }
  | {
      kind: "weekday_after_generation"
      weekday: number
      nth: number
      time?: string | null
    }
  | { kind: "month_day_after_generation"; dayOfMonth: number; time?: string | null }

export type ExpiryRule =
  | { kind: "none" }
  | { kind: "fixed"; date: string; time?: string | null }
  | { kind: "after_creation"; amount: number; unit: "minutes" | "hours" | "days" }
  | { kind: "after_unlock"; amount: number; unit: "minutes" | "hours" | "days" }
  | { kind: "after_generation_days"; days: number; time?: string | null }
  | {
      kind: "weekday_after_generation"
      weekday: number
      nth: number
      time?: string | null
    }
  | { kind: "month_day_after_generation"; dayOfMonth: number; time?: string | null }
  | {
      kind: "weekday_after_unlock"
      weekday: number
      nth: number
      time?: string | null
    }
  | { kind: "month_day_after_unlock"; dayOfMonth: number; time?: string | null }

function parseGmtOffsetToMinutes(offsetText: string): number {
  const match = offsetText.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i)
  if (!match) return 0
  const sign = match[1] === "-" ? -1 : 1
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3] ?? 0)
  return sign * (hours * 60 + minutes)
}

function getTimeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
    year: "numeric",
  }).formatToParts(instant)
  const tzPart = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00"
  return parseGmtOffsetToMinutes(tzPart)
}

function zonedDateTimeToUtc(params: {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  timeZone: string
}): Date {
  const { year, month, day, hour, minute, timeZone } = params
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  const naiveInstant = new Date(naiveUtcMs)
  const offsetMinutes = getTimeZoneOffsetMinutes(naiveInstant, timeZone)
  return new Date(naiveUtcMs - offsetMinutes * 60_000)
}

function convertUtcWallClockToTimeZoneInstant(wallClockUtc: Date, timeZone: string): Date {
  if (!timeZone || timeZone.toUpperCase() === "UTC") return wallClockUtc
  return zonedDateTimeToUtc({
    year: wallClockUtc.getUTCFullYear(),
    month: wallClockUtc.getUTCMonth() + 1,
    day: wallClockUtc.getUTCDate(),
    hour: wallClockUtc.getUTCHours(),
    minute: wallClockUtc.getUTCMinutes(),
    timeZone,
  })
}

function getZonedDateTimeParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant)
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0")
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
  }
}

function parseClock(time?: string | null) {
  if (!time) return { hour: 0, minute: 0 }
  const [h, m] = time.split(":").map((v) => Number(v))
  return {
    hour: Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 0,
    minute: Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0,
  }
}

function atClock(base: Date, time?: string | null) {
  const next = new Date(base.getTime())
  const { hour, minute } = parseClock(time)
  next.setUTCHours(hour, minute, 0, 0)
  return next
}

function addDays(base: Date, days: number) {
  const next = new Date(base.getTime())
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

export function parseUnlockRule(raw: unknown): UnlockRule | null {
  if (!raw || typeof raw !== "object") return null
  const rule = raw as Record<string, unknown>
  const kind = String(rule.kind ?? "")
  if (!kind || kind === "none") return { kind: "none" }
  if (kind === "fixed" && typeof rule.date === "string") {
    return { kind: "fixed", date: rule.date, time: typeof rule.time === "string" ? rule.time : null }
  }
  if (kind === "after_generation_days") {
    return { kind, days: Number(rule.days ?? 0), time: typeof rule.time === "string" ? rule.time : null }
  }
  if (kind === "weekday_after_generation") {
    return {
      kind,
      weekday: Number(rule.weekday ?? 0),
      nth: Math.max(1, Number(rule.nth ?? 1)),
      time: typeof rule.time === "string" ? rule.time : null,
    }
  }
  if (kind === "month_day_after_generation") {
    return {
      kind,
      dayOfMonth: Math.min(31, Math.max(1, Number(rule.dayOfMonth ?? 1))),
      time: typeof rule.time === "string" ? rule.time : null,
    }
  }
  return null
}

export function parseExpiryRule(raw: unknown): ExpiryRule | null {
  if (!raw || typeof raw !== "object") return null
  const rule = raw as Record<string, unknown>
  const kind = String(rule.kind ?? "")
  if (!kind || kind === "none") return { kind: "none" }
  if (kind === "fixed" && typeof rule.date === "string") {
    return { kind: "fixed", date: rule.date, time: typeof rule.time === "string" ? rule.time : null }
  }
  if (kind === "after_creation" || kind === "after_unlock") {
    const unitRaw = String(rule.unit ?? "hours")
    return {
      kind,
      amount: Math.max(0, Number(rule.amount ?? 0)),
      unit: unitRaw === "days" ? "days" : unitRaw === "minutes" ? "minutes" : "hours",
    }
  }
  if (kind === "weekday_after_unlock") {
    return {
      kind,
      weekday: Number(rule.weekday ?? 0),
      nth: Math.max(1, Number(rule.nth ?? 1)),
      time: typeof rule.time === "string" ? rule.time : null,
    }
  }
  if (kind === "month_day_after_unlock") {
    return {
      kind,
      dayOfMonth: Math.min(31, Math.max(1, Number(rule.dayOfMonth ?? 1))),
      time: typeof rule.time === "string" ? rule.time : null,
    }
  }
  const unlockLike = parseUnlockRule(raw)
  if (unlockLike && unlockLike.kind !== "none") return unlockLike
  return null
}

export function resolveUnlockAt(rule: UnlockRule | null, generationAt: Date, timeZone = "UTC"): Date | null {
  if (!rule || rule.kind === "none") return null
  if (rule.kind === "fixed") {
    const candidate = atClock(new Date(`${rule.date}T00:00:00.000Z`), rule.time)
    return convertUtcWallClockToTimeZoneInstant(candidate, timeZone)
  }
  if (rule.kind === "after_generation_days") {
    const candidate = atClock(addDays(generationAt, rule.days), rule.time)
    return convertUtcWallClockToTimeZoneInstant(candidate, timeZone)
  }
  if (rule.kind === "weekday_after_generation") {
    const targetWeekday = ((rule.weekday % 7) + 7) % 7
    let cursor = new Date(generationAt.getTime())
    let matches = 0
    while (matches < rule.nth) {
      if (cursor.getUTCDay() === targetWeekday) {
        const candidate = atClock(cursor, rule.time)
        // Count "today" when it matches, but only if the resolved instant
        // is not already in the past relative to generation time.
        if (candidate.getTime() >= generationAt.getTime()) {
          matches += 1
          if (matches >= rule.nth) return convertUtcWallClockToTimeZoneInstant(candidate, timeZone)
        }
      }
      if (matches < rule.nth) cursor = addDays(cursor, 1)
    }
    return convertUtcWallClockToTimeZoneInstant(atClock(cursor, rule.time), timeZone)
  }
  if (rule.kind === "month_day_after_generation") {
    let cursor = new Date(generationAt.getTime())
    cursor.setUTCDate(1)
    while (true) {
      const lastDay = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate()
      const day = Math.min(lastDay, rule.dayOfMonth)
      const candidate = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), day))
      const withClock = atClock(candidate, rule.time)
      if (withClock.getTime() >= generationAt.getTime()) {
        return convertUtcWallClockToTimeZoneInstant(withClock, timeZone)
      }
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
    }
  }
  return null
}

export function resolveExpiryAt(params: {
  rule: ExpiryRule | null
  generationAt: Date
  createdAt: Date
  unlockAt: Date | null
  timeZone?: string
}): Date | null {
  const { rule, generationAt, createdAt, unlockAt, timeZone = "UTC" } = params
  if (!rule || rule.kind === "none") return null
  const offsetMs = (amount: number, unit: "minutes" | "hours" | "days") =>
    unit === "days"
      ? amount * 24 * 60 * 60 * 1000
      : unit === "hours"
        ? amount * 60 * 60 * 1000
        : amount * 60 * 1000
  if (rule.kind === "after_creation") {
    return new Date(createdAt.getTime() + offsetMs(rule.amount, rule.unit))
  }
  if (rule.kind === "after_unlock") {
    if (!unlockAt) return null
    return new Date(unlockAt.getTime() + offsetMs(rule.amount, rule.unit))
  }
  if (rule.kind === "weekday_after_unlock") {
    if (!unlockAt) return null
    const zonedUnlock = getZonedDateTimeParts(unlockAt, timeZone)
    const unlockWallClockUtc = new Date(
      Date.UTC(
        zonedUnlock.year,
        zonedUnlock.month - 1,
        zonedUnlock.day,
        0,
        0,
        0,
        0,
      ),
    )
    const resolvedWallClockUtc = resolveUnlockAt(
      {
        kind: "weekday_after_generation",
        weekday: rule.weekday,
        nth: rule.nth,
        time: rule.time ?? null,
      },
      unlockWallClockUtc,
      "UTC",
    )
    if (!resolvedWallClockUtc) return null
    return convertUtcWallClockToTimeZoneInstant(resolvedWallClockUtc, timeZone)
  }
  if (rule.kind === "month_day_after_unlock") {
    if (!unlockAt) return null
    const zonedUnlock = getZonedDateTimeParts(unlockAt, timeZone)
    const unlockWallClockUtc = new Date(
      Date.UTC(
        zonedUnlock.year,
        zonedUnlock.month - 1,
        zonedUnlock.day,
        0,
        0,
        0,
        0,
      ),
    )
    const resolvedWallClockUtc = resolveUnlockAt(
      {
        kind: "month_day_after_generation",
        dayOfMonth: rule.dayOfMonth,
        time: rule.time ?? null,
      },
      unlockWallClockUtc,
      "UTC",
    )
    if (!resolvedWallClockUtc) return null
    return convertUtcWallClockToTimeZoneInstant(resolvedWallClockUtc, timeZone)
  }
  return resolveUnlockAt(rule, generationAt, timeZone)
}

