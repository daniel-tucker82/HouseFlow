import { useState } from "react"
import { FlatList, Modal, Pressable, ScrollView, View, useWindowDimensions } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Check, Circle, Gift, LockKeyhole } from "lucide-react-native"
import { completePracticeTask, practiceTaskStates, resetRoutinePractice, type RoutinePractice } from "../../../shared/mobile/routine-practice"
import { Action, Copy, styles, usePalette } from "./ui"

export function PlannerPractice({ practice, onChange, onClose }: {
  practice: RoutinePractice; onChange: (update: (previous: RoutinePractice | null) => RoutinePractice | null) => void; onClose: () => void
}) {
  const colors = usePalette(), { fontScale } = useWindowDimensions()
  const [availableWidth, setAvailableWidth] = useState(0)
  const wide = availableWidth / Math.max(1, fontScale) >= 760, tasks = practiceTaskStates(practice)
  const done = tasks.filter(task => task.status === "completed").length
  const summary = <View style={{ gap: 16 }}><Copy tone="heading">{practice.routineName}</Copy>
    <Copy tone="label">{done} of {tasks.length} complete in practice</Copy>
    <Action secondary label="Start again" disabled={!done} onPress={() => onChange(previous => previous ? resetRoutinePractice(previous) : null)} />
    {tasks.length > 0 && done === tasks.length ? <Copy style={{ color: colors.primary }}>Practice complete. You can start again or return to editing.</Copy> : null}
    {tasks.length > done && !tasks.some(task => task.status === "ready") ? <Copy style={{ color: colors.warning }}>Some steps cannot become ready. Check their prerequisite links in the routine editor.</Copy> : null}
    <Copy>Practice your task order. These taps do not complete real household tasks or send notifications.</Copy>
    <Copy tone="muted">Time and expiry rules apply in live runs. This practice uses the template as it was when you opened it.</Copy>
  </View>
  return <Modal visible animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape-left", "landscape-right"]} onRequestClose={onClose}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} onLayout={event => setAvailableWidth(event.nativeEvent.layout.width)}>
      <View style={[styles.row, { padding: 20, flexWrap: "wrap", borderBottomWidth: 1, borderColor: colors.border }]}>
        <Copy tone="heading" style={{ flex: 1, minWidth: 140 }}>Try it out</Copy><Action secondary label="Back to editing" onPress={onClose} />
      </View>
      <View style={{ flex: 1, flexDirection: wide ? "row" : "column" }}>
        {wide ? <ScrollView style={{ width: 290, flexGrow: 0, borderRightWidth: 1, borderColor: colors.border }} contentContainerStyle={{ padding: 20 }}>{summary}</ScrollView> : null}
        <FlatList style={{ flex: 1 }} data={tasks} keyExtractor={task => task.id} contentContainerStyle={[styles.content, { maxWidth: 850 }]}
          ListHeaderComponent={wide ? undefined : summary}
          ListEmptyComponent={<Copy tone="muted">Add some tasks or rewards to this routine, then try it out.</Copy>}
          renderItem={({ item: task }) => {
            const Icon = task.status === "completed" ? Check : task.status === "waiting" ? LockKeyhole : task.isReward ? Gift : Circle
            const description = task.status === "completed" ? "Completed in this practice run" : task.status === "waiting" ? `Waiting for ${task.waitingFor.join(" + ")}` : "Ready · tap to complete"
            const details = [task.members.join(", ") || "Unassigned", task.isReward ? "Reward" : null,
              task.otherRoutine ? `From ${task.otherRoutine}` : null, description, task.status === "ready" ? task.notes : null].filter(Boolean).join(". ")
            return <Pressable accessibilityRole="button" accessibilityLabel={`${task.status === "ready" ? "Practice completing" : task.status}: ${task.title}. ${details}`}
              accessibilityState={{ disabled: task.status !== "ready" }} disabled={task.status !== "ready"}
              onPress={() => onChange(previous => previous ? completePracticeTask(previous, task.id) : null)}
              style={({ pressed }) => ({ minHeight: 88, padding: 20, gap: 10, borderWidth: 1, borderRadius: 20, borderColor: task.status === "completed" ? colors.primary : colors.border,
                backgroundColor: task.isReward ? colors.reward : colors.surface, opacity: pressed ? 0.75 : 1 })}>
              <View style={styles.row}><Icon size={24} color={task.status === "waiting" ? colors.muted : colors.primary} /><Copy style={{ flex: 1, fontSize: 20, fontWeight: "600" }}>{task.title}</Copy></View>
              <Copy>{description}</Copy><Copy tone="muted">{task.members.join(", ") || "Unassigned"}{task.isReward ? " · Reward" : ""}</Copy>
              {task.otherRoutine ? <Copy tone="muted">From {task.otherRoutine}</Copy> : null}
              {task.status === "ready" && task.notes ? <Copy tone="muted">{task.notes}</Copy> : null}
            </Pressable>
          }} />
      </View>
    </SafeAreaView>
  </Modal>
}
