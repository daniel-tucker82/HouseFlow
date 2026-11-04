import { Modal, ScrollView, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import type { BoardTask } from "../../../shared/mobile/contracts"
import { Action, Card, Copy, styles, usePalette } from "./ui"

export function taskTimeLabel(value: string | null, timezone?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return null
  const date = new Date(value)
  try { return date.toLocaleString(undefined, { timeZone: timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) }
  catch { return date.toISOString() }
}
export function taskWaitingLabel(task: BoardTask, timezone?: string) {
  if (task.status !== "locked") return null
  return task.blocking_task_title ? `After ${task.blocking_task_title}` : taskTimeLabel(task.unlock_at, timezone) ? `Available ${taskTimeLabel(task.unlock_at, timezone)}` : "Not available yet"
}

export function BoardTaskDetails({ task, memberNames, timezone, canEdit, saving, needsAttention, kiosk, onToggle, onClose }: {
  task: BoardTask | null; memberNames: string; timezone?: string; canEdit: boolean; saving: boolean; needsAttention: boolean; kiosk: boolean; onToggle: () => void; onClose: () => void
}) {
  const colors = usePalette(), waiting = task ? taskWaitingLabel(task, timezone) : null
  return <Modal visible animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape-left", "landscape-right"]} onRequestClose={onClose}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><ScrollView contentContainerStyle={[styles.content, { maxWidth: 750 }]}>
      <View style={[styles.row, { flexWrap: "wrap" }]}><Copy tone="heading" style={{ flex: 1, minWidth: 140 }}>{task?.is_reward ? "Reward details" : "Task details"}</Copy><Action secondary label="Close details" onPress={onClose} /></View>
      {task ? <><Copy tone="title">{task.title}</Copy>
        <Copy>{task.status === "completed" ? "Completed" : task.status === "unlocked" ? "Ready to start" : "Waiting"}</Copy>
        {waiting ? <Copy tone="label">{waiting}</Copy> : null}
        <Copy tone="muted">{task.occurrence_title ?? (task.occurrence_kind === "manual" ? "Manual board" : "Routine board")}</Copy>
        <Copy>Assigned to: {memberNames || "Unassigned"}</Copy>
        <Card><Copy tone="heading">Notes</Copy><Copy>{task.description?.trim() ? task.description : "No task notes yet."}</Copy></Card>
        {taskTimeLabel(task.unlock_at, timezone) ? <Copy tone="muted">Availability time: {taskTimeLabel(task.unlock_at, timezone)}</Copy> : null}
        {taskTimeLabel(task.expires_at, timezone) ? <Copy tone="muted">Expiry time: {taskTimeLabel(task.expires_at, timezone)}</Copy> : null}
        {task.unlock_at || task.expires_at ? <Copy tone="muted">Times use {timezone ?? "the device timezone"}.</Copy> : null}
        <Action label={task.status === "completed" ? "Mark incomplete" : "Mark complete"} disabled={!canEdit || task.status === "locked"} onPress={onToggle} />
        {!canEdit && task.status !== "locked" ? <Copy tone="muted">View only on this display.</Copy> : null}
        {needsAttention ? <Copy tone="label" style={{ color: colors.danger }}>A saved change needs {kiosk ? "a parent’s attention" : "attention in Settings"}.</Copy>
          : saving ? <Copy tone="label" style={{ color: colors.primary }}>Saved on this device, waiting to sync.</Copy> : null}
        {task.metadata_sync ? <Card><Copy tone="label" style={{ color: task.metadata_sync === "rejected" ? colors.danger : colors.primary }}>
          {task.metadata_sync === "rejected" ? "Task edit needs attention" : "Task edit waiting to sync"}
        </Copy><Copy tone="muted">{task.metadata_sync === "rejected" ? "Open this run in Runs, then Edit tasks, to review the saved change." : "Your task edits are saved on this device. They will sync when a connection is available."}</Copy></Card> : null}
      </> : <Copy>This task is no longer available on this display. Close these details to return to Today.</Copy>}
    </ScrollView></SafeAreaView>
  </Modal>
}
