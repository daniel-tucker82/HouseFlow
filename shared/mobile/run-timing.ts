import type { Task } from "../../lib/types"
import type { ExpiryRule } from "../../lib/time-rules"
import type { TaskTiming } from "../scheduling"
import type { RunTaskDraft } from "./run-editor"

export type TimingField = "activation" | "expiry" | "combiner" | "all"

/** Seed native date/time controls in the household's timezone, not the device's. */
export function fixedRuleAt(instant: string | null | undefined, timezone: string): Extract<ExpiryRule, { kind: "fixed" }> | null {
  if (!instant || !Number.isFinite(Date.parse(instant))) return null
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant))
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)!.value
  return { kind: "fixed", date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` }
}

export function runTimingInstants(draft: RunTaskDraft, task?: Task) {
  return draft.timing ? { activation: draft.unlockAtOverride ?? null, expiry: draft.expiryAtOverride ?? null }
    : { activation: task?.unlock_at ?? task?.scheduled_time ?? null, expiry: task?.expires_at ?? null }
}

/** Editing one setting must not restart another resolved relative timer. Retain
 * its exact instant (including seconds and the side of a DST overlap). Expiry
 * tied to activation is recalculated when activation is deliberately changed. */
export function changeRunTaskTiming(draft: RunTaskDraft, task: Task | undefined, timing: TaskTiming, field: TimingField): RunTaskDraft {
  const current = runTimingInstants(draft, task)
  const afterActivation = timing.expiryRule && ["after_unlock", "weekday_after_unlock", "month_day_after_unlock"].includes(timing.expiryRule.kind)
  return { ...draft, timing,
    unlockAtOverride: field === "activation" || field === "all" ? null : current.activation,
    expiryAtOverride: field === "expiry" || field === "all" || (field === "activation" && afterActivation) ? null : current.expiry,
  }
}
