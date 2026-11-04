import { useEffect, useRef, useState } from "react"
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, View, useWindowDimensions } from "react-native"
import { AppModal } from "./app-modal"
import { SafeAreaView } from "react-native-safe-area-context"
import { randomUUID } from "expo-crypto"
import { ChevronRight, Gift } from "lucide-react-native"
import type { Routine, Task } from "../../../lib/types"
import { draftForTask, validatePlannerDraft, type PlannerTaskDraft } from "../../../shared/mobile/planner"
import { useBoard, usePlanner, useRuntime } from "../providers/runtime"
import { Action, Card, Copy, Loading, styles, usePalette } from "./ui"
import { PlannerField, PlannerTaskEditor } from "./planner-task-editor"
import { PlannerPendingCreations } from "./planner-pending-creations"
import { PlannerSchedulePanel } from "./planner-schedule-panel"
import { PlannerPractice } from "./planner-practice"
import { createRoutinePractice, type RoutinePractice } from "../../../shared/mobile/routine-practice"

export default function PlannerScreen() {
  const board = useBoard(), state = usePlanner()
  const colors = usePalette()
  if (!board.board?.household) return <View style={[styles.center, { backgroundColor: colors.background }]}><Copy tone="heading">A home for your routines</Copy><Copy tone="muted">Create or join a household in the Household tab to get started.</Copy></View>
  if (board.board.household.role === "member") return <View style={[styles.center, { backgroundColor: colors.background }]}><Copy tone="heading">Your tasks are in Today</Copy><Copy tone="muted">A parent or supervisor manages the household’s routines.</Copy></View>
  if (state.loading && !state.data) return <Loading label="Opening your routines…" />
  return <PlannerWorkspace key={board.board.household.id} householdId={board.board.household.id} />
}

function PlannerWorkspace({ householdId }: { householdId: string }) {
  const { planner, controller, store } = useRuntime()
  const state = usePlanner(), colors = usePalette()
  const { width, fontScale } = useWindowDimensions()
  const wide = width / Math.max(1, fontScale) >= 760
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<PlannerTaskDraft | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [routineForm, setRoutineForm] = useState<{ id: string | null; name: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [practice, setPractice] = useState<RoutinePractice | null>(null)
  const mounted = useRef(true)
  const draftTouched = useRef(false)
  const data = state.data
  const routine = data?.routines.find(item => item.id === selected) ?? data?.routines[0]
  const tasks = data?.tasks.filter(task => task.routine_id === routine?.id) ?? []
  const pending = state.pending.filter(edit => edit.householdId === householdId)
  const rejected = pending.filter(edit => edit.state === "rejected")
  const creations = state.creations.filter(item => item.householdId === householdId)
  const starting = creations.some(item => item.body.action === "createOccurrence" && item.body.routineId === routine?.id)
  const onlineActionDisabled = !state.online || state.busy
  const draftKey = `planner-task-draft:${householdId}`

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void store.setting<PlannerTaskDraft>(controller.accountId, draftKey).then(saved => { if (!cancelled && !draftTouched.current && saved) setDraft(saved) }).catch(error => { if (!cancelled) report(error) })
    return () => { cancelled = true; mounted.current = false }
  }, [controller.accountId, draftKey, store])

  function report(error: unknown) { if (mounted.current) Alert.alert("Unable to save", error instanceof Error ? error.message : "Please try again.") }
  function persistDraft(next: PlannerTaskDraft | null) {
    draftTouched.current = true
    setDraft(next)
    void store.saveSetting(controller.accountId, draftKey, next).catch(report)
  }
  function edit(task?: Task) {
    if (!routine || !data) return
    if (draft && !editorOpen) {
      Alert.alert("You have an unfinished task", "Resume it or discard it below before opening another task.")
      return
    }
    const next = task ? draftForTask(data, task) : { taskId: randomUUID(), routineId: routine.id, isNew: true,
      title: "", notes: "", isReward: false, assigneeIds: [], prerequisiteIds: [] }
    persistDraft(next); setEditorError(null); setEditorOpen(true)
  }
  async function saveTask(value: PlannerTaskDraft) {
    try { validatePlannerDraft(value) } catch (error) { setEditorError(error instanceof Error ? error.message : "Check the task details."); return }
    setEditorError(null)
    if (value.isNew) {
      setEditorBusy(true)
      try {
        await planner.create("createTask", value as unknown as Record<string, unknown>, `Task: ${value.title.trim()}`)
        if (mounted.current) { persistDraft(null); setEditorOpen(false) }
      } catch (error) { if (mounted.current) setEditorError(error instanceof Error ? error.message : "Unable to add this task.") }
      finally { if (mounted.current) setEditorBusy(false) }
    } else {
      setEditorOpen(false)
      try { await planner.saveTask(value); if (mounted.current) persistDraft(null) }
      catch (error) {
        if (mounted.current) { setEditorError(error instanceof Error ? error.message : "Unable to save on this device."); setEditorOpen(true) }
      }
    }
  }
  async function act(work: () => Promise<unknown>, message?: string) {
    try { await work(); if (mounted.current && message) setNotice(message) } catch (error) { report(error) }
  }
  function removeTask(task: Task) {
    Alert.alert(`Remove “${task.title}”?`, "This removes it from the routine template. Existing runs keep their own copy.", [
      { text: "Cancel", style: "cancel" }, { text: "Remove task", style: "destructive", onPress: () => void act(() => planner.run("deleteTask", { taskId: task.id })) },
    ])
  }
  function removeRoutine(value: Routine) {
    Alert.alert(`Delete “${value.name}”?`, "The template and its tasks will be removed. Existing runs and history remain.", [
      { text: "Cancel", style: "cancel" }, { text: "Delete routine", style: "destructive", onPress: () => void act(() => planner.run("deleteRoutine", { routineId: value.id })) },
    ])
  }
  const routineList = <View style={{ gap: 10 }}>
    <Copy tone="label">Your routines</Copy>
    <ScrollView horizontal={!wide} showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 10, paddingBottom: 6 }}>
      {data?.routines.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === routine?.id }}
        onPress={() => { setSelected(item.id); setNotice(null) }} style={{ padding: 16, minHeight: 52, width: wide ? "100%" : Math.min(280, width - 40),
          borderRadius: 14, borderWidth: 1, borderColor: item.id === routine?.id ? colors.primary : colors.border,
          backgroundColor: item.id === routine?.id ? colors.soft : colors.surface }}>
        <View style={styles.row}><Copy style={{ flex: 1, fontWeight: "600" }}>{item.name}</Copy><ChevronRight size={18} color={colors.muted} /></View>
      </Pressable>)}
    </ScrollView>
    <Action secondary label="New routine" disabled={onlineActionDisabled} onPress={() => setRoutineForm({ id: null, name: "" })} />
  </View>
  return <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: colors.background }}>
    <View style={{ flex: 1, flexDirection: wide ? "row" : "column" }}>
      {wide ? <View style={{ width: 290, padding: 20, borderRightWidth: 1, borderColor: colors.border }}><Copy tone="title">Routines</Copy>{routineList}</View> : null}
      <FlatList data={tasks} keyExtractor={task => task.id} style={{ flex: 1 }} contentContainerStyle={[styles.content, { paddingBottom: 32 }]}
        refreshControl={<RefreshControl refreshing={state.loading} onRefresh={() => void planner.refresh()} tintColor={colors.primary} />}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        ListHeaderComponent={<View style={{ gap: 20, marginBottom: 20 }}>
          {!wide ? <><Copy tone="title">Routines</Copy>{routineList}</> : null}
          {!state.online ? <Copy tone="muted">You’re offline. Edits to saved tasks stay on this device and sync when you reconnect.</Copy> : null}
          {state.error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{state.error}</Copy><Action secondary label="Try again" disabled={!state.online} onPress={() => void planner.refresh()} /></View> : null}
          {notice ? <Copy style={{ color: colors.primary }}>{notice}</Copy> : null}
          {draft && !editorOpen ? <Card><Copy tone="label">Unfinished task: {draft.title || "New task"}</Copy><Action label="Resume editing" onPress={() => { setEditorError(null); setEditorOpen(true) }} /><Action secondary label="Discard draft" onPress={() => Alert.alert("Discard this draft?", "These unsaved task details will be removed from this device.", [{ text: "Keep draft", style: "cancel" }, { text: "Discard", style: "destructive", onPress: () => persistDraft(null) }])} /></Card> : null}
          {pending.length ? <Card><Copy tone="label">{pending.length} saved task {pending.length === 1 ? "edit" : "edits"} waiting to sync</Copy>
            {rejected.map(change => <View key={change.id} style={{ gap: 10 }}><Copy style={{ fontWeight: "600" }}>{change.draft.title}</Copy><Copy style={{ color: colors.danger }}>{change.error}</Copy>
              <Action secondary label="Try syncing again" disabled={!state.online} onPress={() => void act(() => planner.retry(change))} />
              <Action secondary label="Use the household’s version" disabled={!state.online} onPress={() => Alert.alert("Discard this saved edit?", "The task will return to the household’s current version.", [{ text: "Cancel", style: "cancel" }, { text: "Discard edit", style: "destructive", onPress: () => void act(() => planner.discard(change)) }])} />
            </View>)}
          </Card> : null}
          {creations.some(item => item.body.action !== "saveRoutineSchedule") ? <Card><PlannerPendingCreations householdId={householdId} excludeSchedules /></Card> : null}
          {routine ? <Card><Copy tone="heading">{routine.name}</Copy><Copy tone="muted">{tasks.length} tasks and rewards · Start a fresh copy whenever your household needs it.</Copy>
            <View style={[styles.row, { flexWrap: "wrap" }]}>
              <Action label={starting ? "Start saved" : "Start routine"} disabled={onlineActionDisabled || starting || !tasks.length} onPress={() => Alert.alert(`Start “${routine.name}”?`, "A fresh copy will appear in Today after your saved request syncs.", [{ text: "Cancel", style: "cancel" }, { text: "Start", onPress: () => void act(() => planner.create("createOccurrence", { routineId: routine.id }, `Start routine: ${routine.name}`)) }])} />
              <Action secondary label="Rename" disabled={onlineActionDisabled} onPress={() => setRoutineForm({ id: routine.id, name: routine.name })} />
              <Action secondary label="Delete" disabled={onlineActionDisabled} onPress={() => removeRoutine(routine)} />
              <Action secondary label="Try it out" disabled={!tasks.length} onPress={() => { if (data) setPractice(createRoutinePractice(data, routine.id)) }} />
            </View>
            {starting ? <Copy tone="muted">Your start request is saved. Let it sync or review it above before changing this template.</Copy> : null}
            <Action secondary label="Add task or reward" disabled={onlineActionDisabled || starting} onPress={() => edit()} />
          </Card> : <Card><Copy tone="heading">Make room for an easier day</Copy><Copy tone="muted">Create a routine, add a few tasks, and choose who will do them.</Copy></Card>}
          <PlannerSchedulePanel householdId={householdId} routine={routine} />
        </View>}
        renderItem={({ item: task }) => {
          const assignees = data?.taskAssignees.filter(row => row.task_id === task.id).map(row => data.members.find(member => member.id === row.user_id)?.name).filter(Boolean) ?? []
          const prerequisites = data?.dependencies.filter(edge => edge.target_task_id === task.id).map(edge => data.tasks.find(item => item.id === edge.source_task_id)?.title ?? "Unavailable task") ?? []
          return <Card><View style={styles.row}>{task.is_reward ? <Gift size={22} color={colors.warning} /> : null}<Copy style={{ flex: 1, fontSize: 20, fontWeight: "600" }}>{task.title}</Copy></View>
            <Copy tone="muted">{assignees.length ? assignees.join(", ") : "Unassigned"}</Copy>
            {task.description ? <Copy>{task.description}</Copy> : null}
            {prerequisites.length ? <Copy tone="muted">After {prerequisites.join(" + ")}</Copy> : null}
            <View style={[styles.row, { flexWrap: "wrap" }]}><Action secondary label="Edit task" disabled={state.busy || starting} onPress={() => edit(task)} /><Action secondary label="Remove" disabled={onlineActionDisabled || starting} onPress={() => removeTask(task)} /></View>
          </Card>
        }}
        ListFooterComponent={data?.occurrences.length ? <View style={{ marginTop: 24, gap: 12 }}><Copy tone="heading">Runs and history</Copy>
          {data.occurrences.slice(0, 20).map(run => <Card key={run.id}><Copy style={{ fontWeight: "600" }}>{run.title || data.routines.find(item => item.id === run.routine_id)?.name || "Task board"}</Copy>
            <Copy tone="muted">{run.status === "active" ? "In progress" : run.status === "completed" ? "Completed" : "Cancelled"} · {run.completed_tasks}/{run.total_tasks} done</Copy>
            <Copy tone="muted">{new Date(run.scheduled_for).toLocaleString()}</Copy>
          </Card>)}
        </View> : undefined} />
    </View>
    {practice ? <PlannerPractice practice={practice} onChange={setPractice} onClose={() => setPractice(null)} /> : null}
    {editorOpen && draft && data ? <PlannerTaskEditor key={draft.taskId} initial={draft} snapshot={data} timezone={state.household?.timezone ?? "UTC"} busy={editorBusy} error={editorError}
      onSave={value => void saveTask(value)} onClose={() => { if (!editorBusy) setEditorOpen(false) }} onDraft={value => { setEditorError(null); persistDraft(value) }} /> : null}
    <AppModal visible={Boolean(routineForm)} animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape-left", "landscape-right"]} onRequestClose={() => { if (!state.busy) setRoutineForm(null) }}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Copy tone="heading">{routineForm?.id ? "Rename routine" : "New routine"}</Copy>
        {state.error ? <Copy style={{ color: colors.danger }}>{state.error}</Copy> : null}
        <PlannerField label="Routine name" value={routineForm?.name ?? ""} onChange={name => setRoutineForm(value => value ? { ...value, name } : null)} />
        <Action label={state.busy ? "Saving…" : "Save routine"} disabled={onlineActionDisabled || !routineForm?.name.trim()} onPress={() => void act(async () => {
          if (!routineForm) return
          if (routineForm.id) {
            const result = await planner.run<{ routine: Routine }>("renameRoutine", { routineId: routineForm.id, name: routineForm.name.trim() })
            if (mounted.current) setSelected(result.routine.id)
          } else {
            await planner.create("createRoutine", { name: routineForm.name.trim(), type: "recurring" }, `Routine: ${routineForm.name.trim()}`)
          }
          if (mounted.current) setRoutineForm(null)
        })} /><Action secondary label="Cancel" disabled={state.busy} onPress={() => setRoutineForm(null)} />
      </ScrollView></SafeAreaView>
    </AppModal>
  </SafeAreaView>
}
