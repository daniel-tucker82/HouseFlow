import { useState } from "react"
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Check, ChevronDown, Gift, LockKeyhole, RefreshCw, Users, WifiOff } from "lucide-react-native"
import type { BoardTask, HouseholdMember } from "../../../shared/mobile/contracts"
import { useBoard, useRuntime } from "../providers/runtime"
import { Action, Card, Copy, Loading, styles, usePalette } from "./ui"

function Person({ member, selected, onPress }: { member: HouseholdMember | null; selected: boolean; onPress: () => void }) {
  const colors = usePalette()
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
    style={[boardStyles.person, { borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.soft : colors.surface }]}>
    <View style={[boardStyles.avatar, { backgroundColor: colors.soft }]}>{member ? <Copy tone="label">{member.name.trim().slice(0, 1).toLocaleUpperCase()}</Copy> : <Users color={colors.primary} size={19} />}</View>
    <Copy tone="label">{member?.name ?? "Everyone"}</Copy>
  </Pressable>
}

function Task({ task, canEdit, memberNames, saving, onPress }: { task: BoardTask; canEdit: boolean; memberNames: string; saving: boolean; onPress: () => void }) {
  const colors = usePalette()
  const complete = task.status === "completed"
  const locked = task.status === "locked"
  const explanation = locked ? task.blocking_task_title ? `After ${task.blocking_task_title}` : task.unlock_at
    ? `Available ${new Date(task.unlock_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Not available yet" : null
  return <Pressable onPress={onPress} disabled={!canEdit || locked} accessibilityRole="checkbox"
    accessibilityLabel={`${task.title}${memberNames ? `, ${memberNames}` : ""}${explanation ? `, ${explanation}` : ""}${saving ? ", saved on this device, waiting to sync" : ""}`}
    accessibilityState={{ checked: complete, disabled: !canEdit || locked }} accessibilityHint={complete ? "Mark incomplete" : "Mark complete"}
    style={({ pressed }) => [boardStyles.task, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.75 : 1 }]}>
    <View style={[boardStyles.check, { borderColor: complete ? colors.primary : colors.border, backgroundColor: complete ? colors.primary : colors.background }]}>
      {complete ? <Check size={23} color={colors.onPrimary} strokeWidth={3} /> : locked ? <LockKeyhole size={18} color={colors.muted} /> : null}
    </View>
    <View style={{ flex: 1, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {task.is_reward ? <Gift size={18} color={colors.warning} /> : null}
        <Copy style={{ flex: 1, fontWeight: "600", textDecorationLine: complete ? "line-through" : "none", color: complete ? colors.muted : colors.text }}>{task.title}</Copy>
      </View>
      {task.description ? <Copy tone="muted" style={{ fontSize: 14, lineHeight: 20 }}>{task.description}</Copy> : null}
      <Copy tone="muted" style={{ fontSize: 13, lineHeight: 19 }}>{[task.occurrence_title, memberNames].filter(Boolean).join(" · ")}</Copy>
      {explanation ? <Copy tone="label" style={{ color: colors.muted }}>{explanation}</Copy> : null}
      {saving ? <Copy tone="label" style={{ color: colors.primary }}>Saved on this device</Copy> : null}
    </View>
  </Pressable>
}

export default function BoardScreen() {
  const state = useBoard()
  const { controller } = useRuntime()
  const colors = usePalette()
  const { width, height, fontScale } = useWindowDimensions()
  const wide = width >= 780 && width > height && fontScale < 1.6
  const [selectedMember, setMember] = useState<string | null>(null)
  const [showCompleted, setShowCompleted] = useState(false)
  const [showHouseholds, setShowHouseholds] = useState(false)
  if (state.loading) return <Loading />
  const board = state.board
  const members = board?.members ?? []
  const memberId = members.some(member => member.id === selectedMember) ? selectedMember : null
  const tasks = (board?.tasks ?? []).filter(task => !memberId || task.assignee_ids.includes(memberId))
  const taskOrder = { unlocked: 0, locked: 1, completed: 2 }
  const visible = tasks.filter(task => showCompleted || task.status !== "completed")
    .sort((a, b) => taskOrder[a.status] - taskOrder[b.status])
  const completed = tasks.filter(task => task.status === "completed").length
  const rejected = state.pending.filter(change => change.state === "rejected")
  const pending = new Set(state.pending.map(change => `${change.occurrenceId}:${change.taskId}`))
  const people = <>
    <Person member={null} selected={memberId === null} onPress={() => setMember(null)} />
    {members.map(member => <Person key={member.id} member={member} selected={memberId === member.id} onPress={() => setMember(member.id)} />)}
  </>
  return <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: colors.background }}>
    <View style={[boardStyles.top, { borderBottomColor: colors.border }]}>
      <View style={{ flex: 1, gap: 3 }}><Copy tone="label" style={{ color: colors.primary, letterSpacing: 1.5 }}>CYNTCH</Copy>
        <Pressable accessibilityRole="button" accessibilityLabel="Choose household" onPress={() => setShowHouseholds(value => !value)} style={styles.row}>
          <Copy tone="heading" style={{ flexShrink: 1 }}>{board?.household.name ?? "Your household"}</Copy><ChevronDown size={18} color={colors.muted} />
        </Pressable>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh tasks" onPress={() => void controller.refresh()} style={boardStyles.iconButton}><RefreshCw color={colors.primary} size={22} /></Pressable>
    </View>
    {showHouseholds ? <ScrollView style={{ maxHeight: height * 0.3 }} contentContainerStyle={{ padding: 16, gap: 8 }}>
      {state.households.map(household => <Action key={household.id} secondary label={household.name} onPress={() => {
        setShowHouseholds(false); setMember(null); void controller.selectHousehold(household.id).catch(error => Alert.alert("Unable to switch household", error.message))
      }} />)}
    </ScrollView> : null}
    {!state.online || state.pending.length > 0 ? <View accessibilityLiveRegion="polite" style={[boardStyles.notice, { backgroundColor: colors.soft }]}>
      {!state.online ? <WifiOff size={17} color={colors.primary} /> : null}
      <Copy tone="label" style={{ flex: 1 }}>{rejected.length ? `${rejected.length} saved ${rejected.length === 1 ? "change needs" : "changes need"} attention in Settings.` : state.pending.length
        ? `${state.pending.length} ${state.pending.length === 1 ? "change saved" : "changes saved"} on this device. ${state.online ? "Syncing…" : "Will sync when connected."}`
        : "You’re offline. You can still complete saved tasks."}</Copy>
    </View> : null}
    {state.error ? <View accessibilityRole="alert" style={boardStyles.notice}><Copy style={{ color: colors.danger, flex: 1 }}>{state.error}</Copy></View> : null}
    <View style={{ flex: 1, flexDirection: wide ? "row" : "column" }}>
      {wide ? <ScrollView style={{ width: 240, flexGrow: 0, borderRightWidth: 1, borderRightColor: colors.border }} contentContainerStyle={{ padding: 20, gap: 12 }}><Copy tone="label">FAMILY</Copy>{people}</ScrollView>
        : <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 16, gap: 10 }}>{people}</ScrollView>}
      <FlatList data={visible} keyExtractor={task => `${task.occurrence_id}:${task.id}`} contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 32, maxWidth: 1000, width: "100%", alignSelf: "center" }}
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void controller.refresh()} tintColor={colors.primary} />}
        ListHeaderComponent={<View style={{ gap: 12, marginBottom: 8 }}><Copy tone="title">{memberId ? `${members.find(member => member.id === memberId)?.name}’s day` : "Together, today"}</Copy>
          <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
            <Copy tone="muted">{tasks.length ? `${completed} of ${tasks.length} done` : "Small steps. More room for family."}</Copy>
            <Pressable accessibilityRole="button" onPress={() => setShowCompleted(value => !value)} style={{ minHeight: 44, justifyContent: "center" }}><Copy tone="label" style={{ color: colors.primary }}>{showCompleted ? "Hide completed" : "Show completed"}</Copy></Pressable>
          </View>
        </View>}
        ListEmptyComponent={<Card><Copy tone="heading">{tasks.length > 0 ? "All done for now" : board ? "Room for a fresh start" : "Welcome to Cyntch"}</Copy>
          <Copy tone="muted">{tasks.length > 0 ? "Enjoy a little breathing room. Your next tasks will appear here." : board ? "Active routines and tasks will appear here for your household." : state.online ? "Create or join a household to start sharing routines." : "Connect once to load your household on this device."}</Copy>
        </Card>}
        renderItem={({ item: task }) => <Task task={task} saving={pending.has(`${task.occurrence_id}:${task.id}`)}
          memberNames={members.filter(member => task.assignee_ids.includes(member.id)).map(member => member.name).join(", ")}
          canEdit={Boolean(board && (board.household.role !== "member" || task.assignee_ids.includes(controller.accountId) || (!task.assignee_ids.length && board.household.leaderId === controller.accountId)))}
          onPress={() => void controller.setCompleted(task, memberId ?? (board?.household.role === "member" ? controller.accountId : task.assignee_ids[0] ?? controller.accountId), task.status !== "completed")} />}
      />
    </View>
  </SafeAreaView>
}

const boardStyles = StyleSheet.create({
  top: { paddingHorizontal: 20, paddingVertical: 14, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1 },
  iconButton: { minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" },
  notice: { paddingHorizontal: 20, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  person: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, paddingRight: 16, minHeight: 52, borderWidth: 1, borderRadius: 18 },
  avatar: { width: 32, height: 32, borderRadius: 16, justifyContent: "center", alignItems: "center" },
  task: { flexDirection: "row", alignItems: "center", gap: 16, padding: 18, borderRadius: 18, borderWidth: 1, minHeight: 86 },
  check: { width: 36, height: 36, borderWidth: 2, borderRadius: 12, alignItems: "center", justifyContent: "center" },
})
