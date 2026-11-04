import { useEffect, useRef, useState } from "react"
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Switch, TextInput, View, type ScrollViewInstance } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Check } from "lucide-react-native"
import { plannerDescendants, type PlannerSnapshot, type PlannerTaskDraft } from "../../../shared/mobile/planner"
import type { RunTaskDraft } from "../../../shared/mobile/run-editor"
import { changeRunTaskTiming, runTimingInstants } from "../../../shared/mobile/run-timing"
import { Action, Card, Copy, styles, usePalette } from "./ui"
import { timingForTask } from "../../../shared/scheduling"
import { PlannerTaskTiming } from "./planner-task-timing"

export function PlannerField({ label, value, onChange, multiline = false, maxLength = 200, editable = true }: {
  label: string; value: string; onChange: (value: string) => void; multiline?: boolean; maxLength?: number; editable?: boolean
}) {
  const colors = usePalette()
  return <View style={{ gap: 8 }}><Copy tone="label">{label}</Copy><TextInput accessibilityLabel={label}
    value={value} onChangeText={onChange} editable={editable} multiline={multiline} maxLength={maxLength} textAlignVertical={multiline ? "top" : "center"}
    style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface, color: colors.text,
      padding: 14, minHeight: multiline ? 110 : 52, fontSize: 17 }} /></View>
}

export function PlannerChoice({ label, selected, onPress, detail }: { label: string; selected: boolean; onPress: () => void; detail?: string }) {
  const colors = usePalette()
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked: selected }} onPress={onPress}
    style={({ pressed }) => [styles.row, { minHeight: 52, padding: 12, borderRadius: 12, backgroundColor: selected ? colors.soft : colors.surface, opacity: pressed ? 0.7 : 1 }]}>
    <View style={{ width: 26, height: 26, borderWidth: 1.5, borderRadius: 7, borderColor: selected ? colors.primary : colors.border, alignItems: "center", justifyContent: "center" }}>
      {selected ? <Check size={18} color={colors.primary} /> : null}
    </View><View style={{ flex: 1 }}><Copy>{label}</Copy>{detail ? <Copy tone="muted">{detail}</Copy> : null}</View>
  </Pressable>
}

export function PlannerTaskEditor<D extends PlannerTaskDraft | RunTaskDraft>({ initial, snapshot, timezone, busy, error, onSave, onClose, onDraft, embedded = false, savingDraft = false }: {
  initial: D; snapshot: PlannerSnapshot; busy: boolean; error: string | null;
  timezone: string;
  embedded?: boolean; savingDraft?: boolean;
  onSave: (draft: D) => void; onClose: () => void; onDraft: (draft: D) => void
}) {
  const [draft, setDraft] = useState(initial)
  const form = useRef<ScrollViewInstance>(null)
  useEffect(() => { if (error) form.current?.scrollTo({ y: 0, animated: true }) }, [error])
  const colors = usePalette()
  const task = snapshot.tasks.find(item => item.id === draft.taskId)
  const timing = draft.timing ?? timingForTask(task)
  const excluded = plannerDescendants(snapshot, draft.taskId)
  const live = "occurrenceId" in draft
  const candidates = snapshot.tasks.filter(task => !excluded.has(task.id) && (live ? task.routine_occurrence_id === draft.occurrenceId : task.routine_id === draft.routineId || draft.prerequisiteIds.includes(task.id)))
  function update(patch: Partial<Omit<PlannerTaskDraft, "routineId">>) { if (busy) return; const next = { ...draft, ...patch }; setDraft(next); onDraft(next) }
  function toggle(key: "assigneeIds" | "prerequisiteIds", id: string) {
    update({ [key]: draft[key].includes(id) ? draft[key].filter(value => value !== id) : [...draft[key], id] })
  }
  const content =
    <SafeAreaView edges={embedded ? [] : ["top", "bottom", "left", "right"]} style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView ref={form} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { maxWidth: 720 }]}>
          <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
            <Copy tone="heading" style={{ flex: 1, minWidth: 160 }}>{draft.isNew ? "Add a task" : "Edit task"}</Copy><Action secondary label="Close" disabled={busy} onPress={onClose} />
          </View>
          {error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{error}</Copy></View> : null}
          {live ? <Copy tone="muted">{savingDraft ? "Saving draft on this device…" : error ? "Check the message above before leaving this draft." : "Draft saved on this device. Changes apply to this run only."}</Copy> : null}
          <PlannerField label="Task name" value={draft.title} editable={!busy} onChange={title => update({ title })} />
          <PlannerField label="Notes" value={draft.notes} editable={!busy} onChange={notes => update({ notes })} multiline maxLength={4000} />
          <Card><View style={styles.row}><View style={{ flex: 1 }}><Copy tone="label">Make this a reward</Copy><Copy tone="muted">Something to look forward to when the earlier tasks are done.</Copy></View>
            <Switch accessibilityLabel="Make this a reward" value={draft.isReward} onValueChange={isReward => update({ isReward })} trackColor={{ true: colors.primary }} />
          </View></Card>
          <Card><Copy tone="heading">Who’s doing it?</Copy><Copy tone="muted">Choose one or more people. Leave everyone unselected for an unassigned task.</Copy>
            {snapshot.members.map(member => <PlannerChoice key={member.id} label={member.name} selected={draft.assigneeIds.includes(member.id)} onPress={() => toggle("assigneeIds", member.id)} />)}
          </Card>
          <Card><Copy tone="heading">What comes before?</Copy><Copy tone="muted">{timing.unlockRule && timing.unlockRule.kind !== "none" && timing.unlockCombiner === "or" ? "Completing all selected tasks or reaching the activation time makes this task available." : "All selected tasks must be complete first."}</Copy>
            {candidates.length ? candidates.map(task => <PlannerChoice key={task.id} label={task.title} selected={draft.prerequisiteIds.includes(task.id)} onPress={() => toggle("prerequisiteIds", task.id)} />)
              : <Copy tone="muted">There are no earlier tasks to choose from yet.</Copy>}
          </Card>
          <PlannerTaskTiming value={timing} timezone={timezone} live={live} changed={draft.timing !== undefined}
            instants={"occurrenceId" in draft ? runTimingInstants(draft, task) : undefined}
            legacy={draft.timing === undefined && Boolean(task?.scheduled_time || task?.unlock_at || task?.expires_at)}
            onChange={(timing, field) => {
              if (busy) return
              if ("occurrenceId" in draft) { const next = changeRunTaskTiming(draft, task, timing, field) as D; setDraft(next); onDraft(next) }
              else update({ timing })
            }} />
          <Action label={busy ? "Saving…" : draft.isNew ? "Add task" : "Save changes"} disabled={busy || !draft.title.trim()} onPress={() => onSave(draft)} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  return embedded ? content : <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { if (!busy) onClose() }}
    supportedOrientations={["portrait", "landscape-left", "landscape-right"]}>{content}</Modal>
}
