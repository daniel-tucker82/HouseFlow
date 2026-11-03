import { useEffect, useRef, useState } from "react"
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Switch, View, type ScrollViewInstance } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { randomUUID } from "expo-crypto"
import { nextRecurrenceDate, type RecurrenceFrequency } from "../../../lib/recurrence"
import { householdWallClock } from "../../../lib/time-rules"
import { monthlyOrdinals, scheduleLimits, validateRoutineSchedule, weekdays, type EditableRecurrenceRule, type RoutineSchedule, type RoutineScheduleDraft } from "../../../shared/routine-schedule"
import { PlannerDateTime, PlannerNumber, PlannerSelect } from "./planner-inputs"
import { Action, Card, Copy, styles, usePalette } from "./ui"

const title = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`
const dayOptions = weekdays.map(value => ({ value, label: title(value) }))
const frequencies: { value: RecurrenceFrequency; label: string }[] = [{ value: "daily", label: "Days" }, { value: "weekly", label: "Weeks" }, { value: "monthly", label: "Months" }, { value: "yearly", label: "Years" }]
const modes = [{ value: "specific_date", label: "A calendar date" }, { value: "nth", label: "A weekday occurrence" }] as const
const yearOrdinals = [...Array.from({ length: 52 }, (_, i) => ({ value: `${i + 1}th` as const, label: ordinal(i + 1) })), { value: "last" as const, label: "Last" }]
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((label, i) => ({ value: String(i + 1), label }))

export function scheduleLabel(rule: EditableRecurrenceRule) {
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[rule.frequency]
  const count = Number.isFinite(rule.interval) ? rule.interval : "…"
  const when = rule.frequency === "weekly" ? ` on ${title(rule.weekday ?? "monday")}` : rule.frequency === "monthly"
    ? rule.monthlyMode === "nth" ? ` on the ${rule.nth} ${title(rule.weekday ?? "monday")}` : ` on day ${rule.dayOfMonth}`
    : rule.frequency === "yearly" ? rule.yearlyMode === "nth" ? ` on the ${rule.nth === "last" ? "last" : ordinal(Number.parseInt(rule.nth ?? "1", 10))} ${title(rule.weekday ?? "monday")} of the year` : ` on ${months[(rule.month ?? 1) - 1]?.label} ${rule.day}` : ""
  return `Every ${count === 1 ? "" : `${count} `}${unit}${count === 1 ? "" : "s"}${when} at ${rule.time}`
}
export function ScheduleSummary({ value }: { value: RoutineSchedule }) {
  return <View style={{ gap: 8 }}>{value.rules.length ? value.rules.map(rule => <Copy key={rule.id}>{scheduleLabel(rule)}</Copy>) : <Copy tone="muted">No automatic recurrences.</Copy>}
    <Copy tone="muted">{value.completeOlderOccurrencesOnNew ? "New runs complete older copies of this routine." : "Older runs stay open when a new copy starts."}</Copy>
  </View>
}
function preview(rule: EditableRecurrenceRule, timezone: string) {
  try {
    validateRoutineSchedule({ rules: [rule], completeOlderOccurrencesOnNew: false })
    const next = nextRecurrenceDate(rule, new Date(), timezone)
    return next ? `Next scheduled time: ${next.toLocaleString(undefined, { timeZone: timezone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "No upcoming time within the supported calendar."
  } catch { return "Finish these settings to see the next scheduled time." }
}

export function PlannerScheduleEditor({ draft, timezone, busy, error, onChange, onSave, onClose }: {
  draft: RoutineScheduleDraft; timezone: string; busy: boolean; error: string | null;
  onChange: (draft: RoutineScheduleDraft) => void; onSave: () => void; onClose: () => void
}) {
  const colors = usePalette(), form = useRef<ScrollViewInstance>(null)
  const [expanded, setExpanded] = useState<string | null>(draft.schedule.rules[0]?.id ?? null)
  useEffect(() => { if (error) form.current?.scrollTo({ y: 0, animated: true }) }, [error])
  function update(schedule: RoutineSchedule) { onChange({ ...draft, schedule }) }
  function edit(id: string, patch: Partial<EditableRecurrenceRule>) { update({ ...draft.schedule, rules: draft.schedule.rules.map(rule => rule.id === id ? { ...rule, ...patch } : rule) }) }
  return <Modal visible animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape-left", "landscape-right"]} onRequestClose={() => { if (!busy) onClose() }}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView ref={form} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { maxWidth: 720 }]}>
        <View style={[styles.row, { flexWrap: "wrap" }]}><Copy tone="heading" style={{ flex: 1, minWidth: 160 }}>Routine schedule</Copy><Action secondary label="Close" disabled={busy} onPress={onClose} /></View>
        <Copy>{draft.routineName}</Copy>
        {error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{error}</Copy></View> : null}
        <Copy tone="muted">Times use {timezone}. Automatic schedules require Premium. Changes take effect after syncing.</Copy>
        {draft.replacesId ? <Card><Copy tone="label">Review your saved changes</Copy><Copy>Your changes are shown below. These are the household’s current settings:</Copy><ScheduleSummary value={draft.baseSchedule} /><Copy tone="muted">Saving will replace these settings with the changes you review below.</Copy></Card> : null}
        <View pointerEvents={busy ? "none" : "auto"} style={{ gap: 20 }}>
          {draft.schedule.rules.map((rule, index) => <Card key={rule.id}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Edit recurrence ${index + 1}`} accessibilityState={{ expanded: expanded === rule.id }} onPress={() => setExpanded(expanded === rule.id ? null : rule.id)} style={{ minHeight: 52, gap: 6 }}>
              <Copy tone="label">Recurrence {index + 1}</Copy><Copy>{scheduleLabel(rule)}</Copy><Copy tone="muted">{expanded === rule.id ? "Hide details" : "Edit details"}</Copy>
            </Pressable>
            {expanded === rule.id ? <>
              <PlannerNumber label="Repeat every" value={rule.interval} minimum={1} maximum={scheduleLimits.interval} onChange={interval => edit(rule.id, { interval })} />
              <PlannerSelect label="Repeat in" value={rule.frequency} options={frequencies} onChange={frequency => edit(rule.id, { frequency, weekday: "monday", monthlyMode: "specific_date", yearlyMode: "specific_date", dayOfMonth: 1, month: 1, day: 1, nth: frequency === "yearly" ? "1th" : "1st" })} />
              <PlannerDateTime label="Start date" mode="date" value={rule.startDate ?? householdWallClock(new Date(), timezone).toISOString().slice(0, 10)} onChange={startDate => edit(rule.id, { startDate })} />
              {rule.frequency === "monthly" ? <PlannerSelect label="Monthly pattern" value={rule.monthlyMode ?? "specific_date"} options={modes} onChange={monthlyMode => edit(rule.id, { monthlyMode, nth: "1st", weekday: "monday", dayOfMonth: 1 })} /> : null}
              {rule.frequency === "yearly" ? <PlannerSelect label="Yearly pattern" value={rule.yearlyMode ?? "specific_date"} options={modes} onChange={yearlyMode => edit(rule.id, { yearlyMode, nth: "1th", weekday: "monday", month: 1, day: 1 })} /> : null}
              {rule.frequency === "monthly" && rule.monthlyMode === "nth" ? <PlannerSelect label="Weekday occurrence in the month" value={rule.nth as typeof monthlyOrdinals[number]} options={monthlyOrdinals.map(value => ({ value, label: title(value) }))} onChange={nth => edit(rule.id, { nth })} /> : null}
              {rule.frequency === "yearly" && rule.yearlyMode === "nth" ? <PlannerSelect label="Weekday occurrence in the year" value={rule.nth as `${number}th` | "last"} options={yearOrdinals} onChange={nth => edit(rule.id, { nth })} /> : null}
              {rule.frequency === "weekly" || (rule.frequency === "monthly" && rule.monthlyMode === "nth") || (rule.frequency === "yearly" && rule.yearlyMode === "nth") ? <PlannerSelect label="Weekday" value={rule.weekday ?? "monday"} options={dayOptions} onChange={weekday => edit(rule.id, { weekday })} /> : null}
              {rule.frequency === "monthly" && rule.monthlyMode === "specific_date" ? <PlannerNumber label="Day of month" value={rule.dayOfMonth ?? 1} minimum={1} maximum={31} onChange={dayOfMonth => edit(rule.id, { dayOfMonth })} /> : null}
              {rule.frequency === "yearly" && rule.yearlyMode === "specific_date" ? <><PlannerSelect label="Month" value={String(rule.month ?? 1)} options={months} onChange={month => edit(rule.id, { month: Number(month) })} /><PlannerNumber label="Day of month" value={rule.day ?? 1} minimum={1} maximum={31} onChange={day => edit(rule.id, { day })} /></> : null}
              <PlannerDateTime label="At time" mode="time" value={rule.time} onChange={time => edit(rule.id, { time })} />
              <Copy tone="muted">{preview(rule, timezone)}</Copy>
              {rule.frequency === "monthly" && rule.monthlyMode === "specific_date" || rule.frequency === "yearly" && rule.yearlyMode === "specific_date" ? <Copy tone="muted">If that date is missing from a shorter month, use its last day.</Copy> : null}
              <Action secondary label={`Remove recurrence ${index + 1}`} onPress={() => update({ ...draft.schedule, rules: draft.schedule.rules.filter(item => item.id !== rule.id) })} />
            </> : null}
          </Card>)}
          <Action secondary label="Add recurrence" disabled={draft.schedule.rules.length >= scheduleLimits.rules} onPress={() => {
            const id = randomUUID(); update({ ...draft.schedule, rules: [...draft.schedule.rules, { id, frequency: "weekly", interval: 1, weekday: "monday", time: "09:00", startDate: householdWallClock(new Date(), timezone).toISOString().slice(0, 10) }] }); setExpanded(id)
          }} />
          <Card><View style={styles.row}><View style={{ flex: 1 }}><Copy tone="label">Complete older runs</Copy><Copy tone="muted">Starting a fresh copy marks older copies and their remaining tasks complete.</Copy></View>
            <Switch accessibilityLabel="Complete older runs" value={draft.schedule.completeOlderOccurrencesOnNew} onValueChange={completeOlderOccurrencesOnNew => update({ ...draft.schedule, completeOlderOccurrencesOnNew })} trackColor={{ true: colors.primary }} />
          </View></Card>
          <Copy tone="muted">If a scheduled time has already passed, the latest due run may start when these changes sync.</Copy>
        </View>
        <Action label={busy ? "Saving…" : "Save schedule"} disabled={busy} onPress={onSave} />
      </ScrollView>
    </KeyboardAvoidingView></SafeAreaView>
  </Modal>
}
