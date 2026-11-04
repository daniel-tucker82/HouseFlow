import { useCallback, useEffect, useState, type RefObject } from "react"
import { Alert, FlatList, View, useWindowDimensions } from "react-native"
import { randomUUID } from "expo-crypto"
import type { HouseholdSummary } from "../../../shared/mobile/contracts"
import { runAsPlanner, runTaskDraft, type RunTaskDraft } from "../../../shared/mobile/run-editor"
import { useRunEditor, useRuntime } from "../providers/runtime"
import { PlannerTaskEditor } from "./planner-task-editor"
import { Action, Card, Copy, Loading, styles, usePalette } from "./ui"

export function RunTaskWorkspace({ household, occurrenceId, onClose, backActionRef }: { household: HouseholdSummary; occurrenceId: string; onClose: () => void; backActionRef: RefObject<(() => void) | null> }) {
  const { runEditor } = useRuntime(), state = useRunEditor(), colors = usePalette()
  const [editing, setEditing] = useState(false), { width, fontScale } = useWindowDimensions()
  const columns = width / Math.max(1, fontScale) >= 840 ? 2 : 1
  const { id, name, timezone, leaderId, role } = household
  useEffect(() => { void runEditor.open({ id, name, timezone, leaderId, role }, occurrenceId).catch(report); return () => runEditor.close() }, [runEditor, id, name, timezone, leaderId, role, occurrenceId])
  function report(error: unknown) { Alert.alert("Unable to update this board", error instanceof Error ? error.message : "Please try again.") }
  const data = state.occurrenceId === occurrenceId && state.household?.id === household.id ? state.data : null
  const pending = state.pending.filter(edit => edit.householdId === household.id && edit.draft.occurrenceId === occurrenceId)
  function begin(draft: RunTaskDraft) { setEditing(true); void runEditor.setDraft(draft).catch(() => {}) }
  const closeEditor = useCallback(() => {
    if (state.error?.startsWith("Draft not saved")) Alert.alert("Draft isn’t saved", "This device could not save your latest changes. Keep editing to try again, or close the editor with this warning still visible.", [
      { text: "Keep editing", style: "cancel" }, { text: "Close editor", onPress: () => setEditing(false) },
    ])
    else setEditing(false)
  }, [state.error])
  useEffect(() => {
    const back = () => { if (!state.busy) { if (editing) closeEditor(); else onClose() } }
    backActionRef.current = back
    return () => { if (backActionRef.current === back) backActionRef.current = null }
  }, [backActionRef, closeEditor, editing, onClose, state.busy])
  if (editing && state.draft && data) return <PlannerTaskEditor key={state.draft.taskId} initial={state.draft} snapshot={runAsPlanner(data)} embedded
    timezone={household.timezone} busy={state.busy} savingDraft={state.draftSaving} error={state.error} online={state.online}
    onDraft={draft => { void runEditor.setDraft(draft).catch(() => {}) }} onClose={closeEditor}
    onSave={draft => { void runEditor.save(draft).then(() => setEditing(false)).catch(report) }} />
  return <View style={{ flex: 1, backgroundColor: colors.background }}>
    <FlatList key={columns} data={data?.tasks ?? []} keyExtractor={task => task.id} numColumns={columns}
      columnWrapperStyle={columns > 1 ? { gap: 16 } : undefined} contentContainerStyle={styles.content}
      ListHeaderComponent={<View style={{ gap: 14 }}>
        <View style={[styles.row, { flexWrap: "wrap" }]}><Copy tone="heading" style={{ flex: 1, minWidth: 140 }}>Tasks in this run</Copy><Action secondary label="Back to run" onPress={onClose} /></View>
        <Copy tone="muted">Changes here apply only to this board. Your routine template and other runs stay as they are.</Copy>
        {!state.online ? <Copy tone="muted">You’re offline. Existing task edits save on this device; connect to add new tasks.</Copy> : null}
        {state.error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{state.error}</Copy></View> : null}
        {state.refreshError ? <Copy tone="muted">{state.refreshError}</Copy> : null}
        <Action secondary label={state.loading ? "Refreshing…" : "Refresh board"} disabled={!state.online || state.loading || state.busy} onPress={() => void runEditor.refresh()} />
        {state.draft ? <Card><Copy tone="label">Unfinished task: {state.draft.title || "New task"}</Copy>
          <Action label="Continue editing" onPress={() => setEditing(true)} />
          <Action secondary label="Discard draft" onPress={() => Alert.alert("Discard this draft?", "The unfinished changes saved on this device will be removed.", [{ text: "Keep draft", style: "cancel" }, { text: "Discard", style: "destructive", onPress: () => void runEditor.setDraft(null).catch(report) }])} />
        </Card> : null}
        {data && !state.draft && data.occurrence.status !== "cancelled" ? <Action label="Add task to this run" disabled={state.busy} onPress={() => begin({ taskId: randomUUID(), occurrenceId,
          routineId: data.occurrence.routine_id, isNew: true, title: "", notes: "", isReward: false, assigneeIds: [], prerequisiteIds: [] })} /> : null}
        {pending.map(edit => <Card key={edit.id}><Copy tone="label">{edit.draft.title}</Copy>
          <Copy tone="muted">{edit.state === "pending" ? "Saved on this device. Waiting to sync." : edit.error}</Copy>
          {edit.state === "rejected" ? <>
            <Action secondary label="Try syncing task again" disabled={!state.online} onPress={() => void runEditor.retry(edit).catch(report)} />
            <Action secondary label="Discard saved task change" onPress={() => Alert.alert("Discard this saved change?", "The current household version will be restored. An already-created task is not deleted.", [{ text: "Keep change", style: "cancel" }, { text: "Discard", style: "destructive", onPress: () => void runEditor.discard(edit).catch(report) }])} />
          </> : null}
        </Card>)}
      </View>}
      ListEmptyComponent={state.loading && !data ? <Loading label="Opening task details…" /> : <Card><Copy>{data ? "Add the first task to this board." : "Load this board to edit its tasks."}</Copy></Card>}
      renderItem={({ item: task }) => <Card style={{ flex: 1 }}><Copy tone="heading">{task.title}</Copy>{task.is_reward ? <Copy tone="label">Reward</Copy> : null}
        {task.description ? <Copy tone="muted">{task.description}</Copy> : null}
        <Action secondary label={`Edit ${task.title}`} disabled={state.busy || Boolean(state.draft) || data?.occurrence.status === "cancelled" || pending.some(edit => edit.draft.taskId === task.id && edit.draft.isNew)}
          onPress={() => { if (data) begin(runTaskDraft(data, task)) }} />
        <Action secondary label={`Delete ${task.title}`} disabled={!state.online || state.busy || Boolean(state.draft) || pending.length > 0 || data?.occurrence.status === "cancelled"}
          onPress={() => Alert.alert("Delete this task?", `“${task.title}” will be removed from this run, including its prerequisite links. The template and other runs will stay.`, [
            { text: "Keep task", style: "cancel" }, { text: "Delete task", style: "destructive", onPress: () => void runEditor.deleteTask(task.id).catch(report) },
          ])} />
      </Card>} />
  </View>
}
