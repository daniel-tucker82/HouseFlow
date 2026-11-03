import { useEffect, useRef, useState } from "react"
import { Alert, View } from "react-native"
import type { Routine } from "../../../lib/types"
import { scheduleForRoutine, validateRoutineSchedule, type RoutineScheduleDraft } from "../../../shared/routine-schedule"
import type { PlannerCreation } from "../../../shared/mobile/planner"
import { usePlanner, useRuntime } from "../providers/runtime"
import { Action, Card, Copy } from "./ui"
import { PlannerScheduleEditor, ScheduleSummary } from "./planner-schedule-editor"

export function PlannerSchedulePanel({ routine, householdId }: { routine?: Routine; householdId: string }) {
  const { planner, controller, store } = useRuntime(), state = usePlanner()
  const [draft, setDraft] = useState<RoutineScheduleDraft | null>(null), [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState<string | null>(null)
  const mounted = useRef(true), saving = useRef(false), writes = useRef(Promise.resolve()), touched = useRef(false)
  const key = `planner-schedule-draft:${householdId}`
  const pending = state.creations.filter(item => item.householdId === householdId && item.body.action === "saveRoutineSchedule")
  const blocked = state.creations.some(item => item.householdId === householdId && item.body.routineId === routine?.id && ["saveRoutineSchedule", "createOccurrence"].includes(String(item.body.action)))
  function report(cause: unknown) { if (mounted.current) Alert.alert("Unable to save schedule", cause instanceof Error ? cause.message : "Please try again.") }
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void store.setting<RoutineScheduleDraft>(controller.accountId, key).then(value => { if (!cancelled && !touched.current) setDraft(value) }).catch(report).finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true; mounted.current = false }
  }, [controller.accountId, key, store])
  function persist(value: RoutineScheduleDraft | null) {
    if (saving.current) return
    touched.current = true; setDraft(value); setError(null)
    writes.current = writes.current.catch(() => undefined).then(() => store.saveSetting(controller.accountId, key, value))
    void writes.current.catch(report)
  }
  function edit() {
    if (draft) { Alert.alert("You have an unfinished schedule", "Resume it or discard the draft before editing another schedule."); return }
    if (!routine) return
    const schedule = scheduleForRoutine(routine)
    persist({ routineId: routine.id, routineName: routine.name, baseSchedule: schedule, schedule }); setOpen(true)
  }
  async function save() {
    if (!draft || saving.current) return
    try { validateRoutineSchedule(draft.schedule) } catch (cause) { setError(cause instanceof Error ? cause.message : "Check the recurrence settings."); return }
    saving.current = true; setBusy(true); setError(null)
    try {
      await writes.current
      await planner.create("saveRoutineSchedule", { routineId: draft.routineId, baseSchedule: draft.baseSchedule, schedule: draft.schedule }, `Schedule: ${draft.routineName}`, draft.replacesId)
      // The transaction cleared the persisted draft with the queued submission.
      if (mounted.current) { setDraft(null); setOpen(false) }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to save on this device.") }
    finally { saving.current = false; if (mounted.current) setBusy(false) }
  }
  async function review(item: PlannerCreation) {
    if (draft) { Alert.alert("You have an unfinished schedule", "Resume it or discard the draft before reviewing another saved schedule."); return }
    setBusy(true)
    try { const next = await planner.reviewSchedule(item); if (mounted.current) { persist(next); setOpen(true) } }
    catch (cause) { report(cause) } finally { if (mounted.current) setBusy(false) }
  }
  return <View style={{ gap: 16 }}>
    {draft && !open ? <Card><Copy tone="label">Unfinished schedule: {draft.routineName}</Copy><Action label="Resume schedule" onPress={() => { setError(null); setOpen(true) }} />
      <Action secondary label="Discard schedule draft" onPress={() => Alert.alert("Discard this draft?", "This removes the unfinished form. Any previously saved request stays available for review.", [{ text: "Keep draft", style: "cancel" }, { text: "Discard", style: "destructive", onPress: () => persist(null) }])} />
    </Card> : null}
    {pending.map(item => <Card key={item.id}><Copy tone="label">{item.label}</Copy><Copy tone="muted">{item.state === "pending" ? "Saved on this device. Waiting to sync with your household." : item.error}</Copy>
      {item.state === "rejected" ? <><Action label="Review saved schedule" disabled={!state.online || busy} onPress={() => void review(item)} />
        <Action secondary label="Try syncing again" disabled={!state.online || busy} onPress={() => void planner.retryCreation(item).catch(report)} />
        <Action secondary label="Discard saved schedule" disabled={busy} onPress={() => Alert.alert("Discard this saved schedule?", "Your household’s current settings will be kept.", [{ text: "Keep request", style: "cancel" }, { text: "Discard", style: "destructive", onPress: () => void planner.discardCreation(item).catch(report) }])} /></> : null}
    </Card>)}
    {routine ? <Card><Copy tone="heading">Schedule</Copy><ScheduleSummary value={scheduleForRoutine(routine)} /><Copy tone="muted">Times use {state.household?.timezone ?? "UTC"}.</Copy>
      <Action secondary label="Edit schedule" disabled={!loaded || busy || state.busy || blocked} onPress={edit} />
    </Card> : null}
    {open && draft ? <PlannerScheduleEditor draft={draft} timezone={state.household?.timezone ?? "UTC"} busy={busy} error={error} onChange={persist} onSave={() => void save()} onClose={() => { if (!saving.current) setOpen(false) }} /> : null}
  </View>
}
