import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { Alert, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, TextInput, View, useWindowDimensions } from "react-native"
import { useFocusEffect } from "expo-router"
import { SafeAreaView } from "react-native-safe-area-context"
import { ChevronRight } from "lucide-react-native"
import type { RunSnapshot, RunSummary } from "../../../shared/mobile/runs"
import type { BoardTask } from "../../../shared/mobile/contracts"
import { useBoard, useRuns, useRuntime } from "../providers/runtime"
import { BoardTaskRow } from "./board-screen"
import { PlannerSelect } from "./planner-inputs"
import { NewTaskBoard } from "./new-task-board"
import { RunTaskWorkspace } from "./run-task-workspace"
import { Action, Card, Copy, Loading, styles, usePalette } from "./ui"

const dateLabel = (run: RunSummary, timezone: string) => new Date(run.scheduled_for).toLocaleString(undefined, { timeZone: timezone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
function report(error: unknown) { Alert.alert("Unable to update runs", error instanceof Error ? error.message : "Please try again.") }

export default function RunsScreen() {
  const { runs } = useRuntime(), state = useRuns(), board = useBoard(), colors = usePalette()
  const household = state.household
  const backActionRef = useRef<(() => void) | null>(null)
  const { width, fontScale } = useWindowDimensions(), columns = width / Math.max(1, fontScale) >= 840 ? 2 : 1
  useFocusEffect(useCallback(() => { runs.setVisible(true); return () => runs.setVisible(false) }, [runs]))
  if (!household) return <View style={[styles.center, { backgroundColor: colors.background }]}><Copy tone="heading">Your household’s runs</Copy><Copy tone="muted">Choose a household in Today to see its active runs and history.</Copy></View>
  return <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: colors.background }}>
    <NewTaskBoard key={household.id} householdId={household.id} enabled={household.role !== "member"}>{boardControls =>
    <FlatList key={columns} numColumns={columns} columnWrapperStyle={columns > 1 ? { gap: 16 } : undefined} data={state.page?.items ?? []} keyExtractor={run => run.id}
      contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void runs.refresh()} tintColor={colors.primary} />}
      ListHeaderComponent={<View style={{ gap: 16 }}><Copy tone="title">Runs</Copy><Copy tone="muted">{household.name} · Each run is a copy of a routine, or a board of one-off tasks.</Copy>
        {boardControls}
        <View style={styles.row}>{(["active", "past"] as const).map(view => <Pressable key={view} accessibilityRole="tab" accessibilityState={{ selected: state.view === view }}
          onPress={() => void runs.selectView(view).catch(report)} style={[styles.action, { flex: 1, backgroundColor: state.view === view ? colors.primary : colors.soft }]}><Copy style={{ color: state.view === view ? colors.onPrimary : colors.text, textAlign: "center", fontWeight: "600" }}>{view === "active" ? "Active runs" : "Past runs"}</Copy></Pressable>)}</View>
        {!board.online ? <Copy tone="muted">You’re offline. Previously opened runs are available here; saved changes will sync when connected.</Copy> : null}
        {state.error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{state.error}</Copy></View> : null}
      </View>}
      ListEmptyComponent={state.loading ? <Loading label="Opening your runs…" /> : <Card><Copy tone="heading">{state.view === "active" ? "No active runs" : "No past runs loaded"}</Copy><Copy tone="muted">{!board.online ? "Connect to load this household’s runs." : state.view === "active" ? "Start a routine in Routines. Its tasks will appear here and in Today." : "Completed runs will appear here. Your history is kept when your plan changes."}</Copy></Card>}
      ListFooterComponent={<View style={{ gap: 12 }}>{state.page?.nextCursor ? <Action secondary label={state.refreshing ? "Loading…" : "Load more runs"} disabled={!board.online || state.refreshing} onPress={() => void runs.refresh(true)} /> : null}
        {state.error && board.online ? <Action secondary label="Try again" disabled={state.refreshing} onPress={() => void runs.refresh()} /> : null}</View>}
      renderItem={({ item: run }) => <Pressable accessibilityRole="button" accessibilityLabel={`Open ${run.title}, ${dateLabel(run, state.household!.timezone)}, ${run.completed_tasks} of ${run.total_tasks} done`}
        onPress={() => void runs.openRun(run.id).catch(report)} style={{ flex: 1 }}><Card><View style={styles.row}><Copy tone="heading" style={{ flex: 1 }}>{run.title}</Copy><ChevronRight color={colors.primary} size={22} /></View>
        <Copy tone="muted">{dateLabel(run, state.household!.timezone)}</Copy><Copy>{run.status === "cancelled" ? "Cancelled" : `${run.completed_tasks} of ${run.total_tasks} done`}</Copy>
      </Card></Pressable>} />
    }</NewTaskBoard>
    <Modal visible={Boolean(state.runId)} animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape-left", "landscape-right"]} onRequestClose={() => {
      if (Keyboard.isVisible()) Keyboard.dismiss()
      else if (backActionRef.current) backActionRef.current()
      else runs.closeRun()
    }}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        {state.run ? <RunDetails key={`${state.runId}:${state.focusedTaskId ?? ""}`} snapshot={state.run} backActionRef={backActionRef} /> : <View style={[styles.content, { flex: 1 }]}><Action secondary label="Close run" onPress={() => runs.closeRun()} />
          {state.runLoading ? <Loading label="Opening this run…" /> : <><Copy>{state.runError ?? "This run is not available on this device."}</Copy>{board.online ? <Action label="Try again" onPress={() => void runs.refreshRun()} /> : null}</>}
        </View>}
      </SafeAreaView>
    </Modal>
  </SafeAreaView>
}

function RunDetails({ snapshot, backActionRef }: { snapshot: RunSnapshot; backActionRef: RefObject<(() => void) | null> }) {
  const { runs, controller } = useRuntime(), state = useRuns(), board = useBoard(), colors = usePalette()
  const [selectedMember, setMember] = useState("all")
  const [renaming, setRenaming] = useState(false), [name, setName] = useState(snapshot.run.title)
  const [editingTasks, setEditingTasks] = useState(false)
  const managing = Boolean(state.managing), canManage = snapshot.household.role !== "member"
  useEffect(() => {
    if (canManage && editingTasks) return
    const back = () => { if (!managing) { if (renaming) setRenaming(false); else runs.closeRun() } }
    backActionRef.current = back
    return () => { if (backActionRef.current === back) backActionRef.current = null }
  }, [backActionRef, canManage, editingTasks, managing, renaming, runs])
  const memberId = snapshot.members.some(member => member.id === selectedMember) ? selectedMember : "all"
  const tasks = snapshot.tasks.filter(task => memberId === "all" || task.assignee_ids.includes(memberId))
  const focused = tasks.find(task => task.id === state.focusedTaskId)
  const pending = new Map(board.pending.filter(change => change.householdId === snapshot.household.id && change.occurrenceId === snapshot.run.id).map(change => [change.taskId, change]))
  const taskRow = (task: BoardTask) => <BoardTaskRow task={task} timezone={snapshot.household.timezone} saving={pending.has(task.id)} needsAttention={pending.get(task.id)?.state === "rejected"}
    memberNames={snapshot.members.filter(member => task.assignee_ids.includes(member.id)).map(member => member.name).join(", ")}
    canEdit={!managing && snapshot.run.status !== "cancelled" && (snapshot.household.role !== "member" || task.assignee_ids.includes(controller.accountId))}
    onPress={() => void runs.setCompleted(task, memberId !== "all" ? memberId : snapshot.household.role === "member" ? controller.accountId : task.assignee_ids[0] ?? controller.accountId, task.status !== "completed").catch(report)} />
  const rename = () => void runs.renameRun(snapshot.run.id, name).then(saved => { if (saved) setRenaming(false) }).catch(report)
  const remove = () => Alert.alert("Delete this run?", `“${snapshot.run.title}” and its task history will be removed for everyone in this household. The routine template and other runs will stay.${pending.size ? " Saved task changes for this run will no longer be applied." : ""}`,
    [{ text: "Keep run", style: "cancel" }, { text: "Delete run", style: "destructive", onPress: () => void runs.deleteRun(snapshot.run.id).catch(report) }])
  if (canManage && editingTasks) return <RunTaskWorkspace household={snapshot.household} occurrenceId={snapshot.run.id} backActionRef={backActionRef} onClose={() => { setEditingTasks(false); void runs.refreshRun() }} />
  if (canManage && renaming) return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={[styles.content, { maxWidth: 800, gap: 12 }]}>
      <Copy tone="label">Run name</Copy>
      <TextInput accessibilityLabel="Run name" value={name} onChangeText={setName} editable={!managing} autoFocus returnKeyType="done" disableFullscreenUI
        onSubmitEditing={() => { if (board.online && !managing && name.trim()) rename() }}
        style={{ minHeight: 52, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, fontSize: 16, color: colors.text, backgroundColor: colors.surface }} />
      <View style={[styles.row, { flexWrap: "wrap" }]}><Action label={state.managing === "rename" ? "Saving name…" : "Save name"} disabled={!board.online || managing || !name.trim()} onPress={rename} />
        <Action secondary label="Cancel rename" disabled={managing} onPress={() => setRenaming(false)} /></View>
      <Copy tone="muted">This changes the name of this run. The routine template keeps its name.</Copy>
      {!board.online ? <Copy tone="muted">Connect to save this name. Your entry is kept here.</Copy> : null}
      {state.runError ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{state.runError}</Copy>
        <Action secondary label="Refresh run" disabled={!board.online || managing} onPress={() => void runs.refreshRun()} /></View> : null}
    </ScrollView>
  </KeyboardAvoidingView>
  return <FlatList data={tasks.filter(task => task.id !== focused?.id)} keyExtractor={task => task.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={[styles.content, { maxWidth: 800 }]} refreshControl={<RefreshControl refreshing={state.runLoading} onRefresh={() => void runs.refreshRun()} tintColor={colors.primary} />}
    ListHeaderComponent={<View style={{ gap: 16 }}><View style={[styles.row, { flexWrap: "wrap" }]}><Copy tone="heading" style={{ flex: 1, minWidth: 160 }}>{snapshot.run.title}</Copy><Action secondary label="Close run" disabled={managing} onPress={() => runs.closeRun()} /></View>
      <Copy tone="muted">{dateLabel(snapshot.run, snapshot.household.timezone)} · {snapshot.household.timezone}</Copy>
      <Copy>{snapshot.run.status === "cancelled" ? "This run was cancelled. Its tasks cannot be changed." : `${snapshot.run.completed_tasks} of ${snapshot.run.total_tasks} done`}</Copy>
      {!board.online ? <Copy tone="muted">{snapshot.run.status === "cancelled" ? "Saved on this device for viewing offline." : "Saved on this device. You can update these tasks offline."}</Copy> : null}
      {[...pending.values()].some(change => change.state === "rejected") ? <Copy style={{ color: colors.danger }}>A saved change needs attention in Settings.</Copy> : null}
      {state.runError ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{state.runError}</Copy>
        <Action secondary label="Refresh run" disabled={!board.online || managing} onPress={() => void runs.refreshRun()} /></View> : null}
      {canManage ? <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Action secondary label="Rename run" disabled={!board.online || managing} onPress={() => { setName(snapshot.run.title); setRenaming(true) }} />
        <Action secondary label="Edit tasks" disabled={managing || snapshot.run.status === "cancelled"} onPress={() => setEditingTasks(true)} />
        <Action secondary label={state.managing === "delete" ? "Deleting run…" : "Delete run"} disabled={!board.online || managing} onPress={remove} />
      </View> : null}
      {canManage && !board.online ? <Copy tone="muted">Connect to rename or delete this run.</Copy> : null}
      <PlannerSelect label="Show tasks for" value={memberId} options={[{ value: "all", label: "Everyone" }, ...snapshot.members.map(member => ({ value: member.id, label: member.name }))]} onChange={setMember} />
      {focused ? <View style={{ gap: 12 }}><Copy tone="label">From your notification</Copy>{taskRow(focused)}{tasks.length > 1 ? <Copy tone="label">Other tasks in this run</Copy> : null}</View> : null}
      {state.focusedTaskId && !snapshot.tasks.some(task => task.id === state.focusedTaskId) ? <Copy tone="muted">The task in this notification is no longer part of this run.</Copy> : null}
    </View>}
    ListEmptyComponent={focused ? undefined : <Card><Copy tone="muted">{snapshot.tasks.length ? "No tasks for this person in this run." : "There are no tasks in this run."}</Copy></Card>}
    renderItem={({ item: task }) => taskRow(task)}
  />
}
