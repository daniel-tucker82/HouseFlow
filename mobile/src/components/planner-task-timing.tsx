import { useState } from "react"
import { View } from "react-native"
import type { ExpiryRule, UnlockRule } from "../../../lib/time-rules"
import { durationLimits, type TaskTiming } from "../../../shared/scheduling"
import { PlannerDateTime, PlannerNumber, PlannerSelect } from "./planner-inputs"
import { Action, Card, Copy } from "./ui"

type Kind = ExpiryRule["kind"]
const commonOptions: { value: Kind; label: string }[] = [
  { value: "none", label: "No time rule" },
  { value: "fixed", label: "On a date" },
  { value: "after_generation_days", label: "Days after the run starts" },
  { value: "weekday_after_generation", label: "A weekday after the run starts" },
  { value: "month_day_after_generation", label: "A day of the month after the run starts" },
]
const expiryOptions: { value: Kind; label: string }[] = [...commonOptions,
  { value: "after_creation", label: "A duration after task creation" },
  { value: "after_unlock", label: "A duration after becoming available" },
  { value: "weekday_after_unlock", label: "A weekday after becoming available" },
  { value: "month_day_after_unlock", label: "A day of the month after becoming available" },
]
const weekdayOptions = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, index) => ({ label, value: String(index) }))

function defaultRule(kind: Kind, timezone: string): ExpiryRule | null {
  switch (kind) {
    case "none": return null
    case "fixed": {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date())
      const part = (name: string) => parts.find(item => item.type === name)!.value
      return { kind, date: `${part("year")}-${part("month")}-${part("day")}`, time: "09:00" }
    }
    case "after_creation": case "after_unlock": return { kind, amount: 1, unit: "hours" }
    case "after_generation_days": return { kind, days: 1, time: "09:00" }
    case "weekday_after_generation": case "weekday_after_unlock": return { kind, weekday: 1, nth: 1, time: "09:00" }
    case "month_day_after_generation": case "month_day_after_unlock": return { kind, dayOfMonth: 1, time: "09:00" }
  }
}

function RuleEditor({ label, rule, expiry = false, timezone, onChange }: {
  label: string; rule: ExpiryRule | null; expiry?: boolean; timezone: string; onChange: (rule: ExpiryRule | null) => void
}) {
  return <View style={{ gap: 14 }}>
    <PlannerSelect label={label} value={rule?.kind ?? "none"} options={expiry ? expiryOptions : commonOptions} onChange={kind => onChange(defaultRule(kind, timezone))} />
    {rule?.kind === "fixed" ? <PlannerDateTime label={`${label} date`} mode="date" value={rule.date} onChange={date => onChange({ ...rule, date })} /> : null}
    {rule?.kind === "after_generation_days" ? <PlannerNumber label={`${label}: days after run starts`} value={rule.days} onChange={days => onChange({ ...rule, days })} /> : null}
    {rule?.kind === "weekday_after_generation" || rule?.kind === "weekday_after_unlock" ? <>
      <PlannerSelect label={`${label} weekday`} value={String(rule.weekday)} options={weekdayOptions} onChange={weekday => onChange({ ...rule, weekday: Number(weekday) })} />
      <PlannerNumber label={`${label}: which occurrence of this weekday?`} minimum={1} maximum={5200} value={rule.nth} onChange={nth => onChange({ ...rule, nth })} />
      <Copy tone="muted">1 means the first matching weekday at or after {rule.kind === "weekday_after_unlock" ? "the task becomes available" : "the run starts"}. A time that has already passed is skipped.</Copy>
    </> : null}
    {rule?.kind === "month_day_after_generation" || rule?.kind === "month_day_after_unlock" ? <>
      <PlannerNumber label={`${label} day of month`} minimum={1} maximum={31} value={rule.dayOfMonth} onChange={dayOfMonth => onChange({ ...rule, dayOfMonth })} />
      <Copy tone="muted">Shorter months use their last day. A time that has already passed moves to next month.</Copy>
    </> : null}
    {rule?.kind === "after_creation" || rule?.kind === "after_unlock" ? <>
      <PlannerNumber label={`${label} duration`} maximum={durationLimits[rule.unit]} value={rule.amount} onChange={amount => onChange({ ...rule, amount })} />
      <PlannerSelect label={`${label} duration unit`} value={rule.unit} options={[{ value: "minutes", label: "Minutes" }, { value: "hours", label: "Hours" }, { value: "days", label: "Days (24 hours)" }]} onChange={unit => onChange({ ...rule, unit })} />
    </> : rule && rule.kind !== "none" ? <PlannerDateTime label={`${label} time`} mode="time" value={rule.time ?? "00:00"} onChange={time => onChange({ ...rule, time })} /> : null}
  </View>
}

export function PlannerTaskTiming({ value, timezone, legacy, onChange }: {
  value: TaskTiming; timezone: string; legacy: boolean; onChange: (value: TaskTiming) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const active = Boolean((value.unlockRule && value.unlockRule.kind !== "none") || (value.expiryRule && value.expiryRule.kind !== "none") || legacy)
  return <Card><Copy tone="heading">Timing</Copy>
    <Copy tone="muted">{active ? "This task has timing settings." : "Add activation or expiry rules with Premium."}</Copy>
    <Action secondary label={expanded ? "Hide timing settings" : "Edit timing settings"} onPress={() => setExpanded(!expanded)} />
    {expanded ? <>
      <Copy tone="muted">Times use your household timezone: {timezone}. Changes apply to future runs.</Copy>
      {legacy ? <Copy tone="muted">This template also has an older saved time. Changing timing here replaces it; clearing timing removes it.</Copy> : null}
      <RuleEditor label="Activation" rule={value.unlockRule} timezone={timezone} onChange={unlockRule => onChange({ ...value, unlockRule: unlockRule as UnlockRule | null })} />
      {value.unlockRule && value.unlockRule.kind !== "none" ? <PlannerSelect label="Combine time and prerequisites" value={value.unlockCombiner}
        options={[{ value: "and", label: "Both must be ready" }, { value: "or", label: "Either can make the task available" }]}
        onChange={unlockCombiner => onChange({ ...value, unlockCombiner })} /> : null}
      <RuleEditor label="Expiry" rule={value.expiryRule} expiry timezone={timezone} onChange={expiryRule => onChange({ ...value, expiryRule })} />
      <Copy tone="muted">Expiry marks the task complete automatically. Rules based on availability wait until the task actually becomes available. When clocks change, a missing time moves forward by the gap; a repeated time uses its first occurrence.</Copy>
      {active ? <Action secondary label="Clear all timing" onPress={() => onChange({ unlockRule: null, expiryRule: null, unlockCombiner: "and" })} /> : null}
    </> : null}
  </Card>
}
