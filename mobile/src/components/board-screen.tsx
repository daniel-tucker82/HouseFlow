import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Bell, Check, ChevronDown, Gift, LockKeyhole, RefreshCw, Search, Users, WifiOff } from "lucide-react-native"
import { router } from "expo-router"
import type { BoardTask, HouseholdMember } from "../../../shared/mobile/contracts"
import type { NativeKioskSession } from "../../../shared/mobile/kiosk"
import { boardCompletionActor, boardDisplayAccess, boardTaskKey, defaultBoardDisplay, filterBoardTasks, orderBoardTasks, taskMembers, type BoardDisplayPreferences, type BoardFilter } from "../../../shared/mobile/board-view"
import { useBoard, useRuntime } from "../providers/runtime"
import { Action, Card, Copy, Loading, styles, usePalette } from "./ui"
import { BoardDisplaySettings } from "./board-display-settings"
import { BoardTaskDetails, taskWaitingLabel } from "./board-task-details"

function Person({ member, selected, onPress, allLabel }: { member: HouseholdMember | null; selected: boolean; onPress: () => void; allLabel?: string }) {
  const colors = usePalette()
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
    style={[boardStyles.person, { borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.soft : colors.surface }]}>
    <View style={[boardStyles.avatar, { backgroundColor: colors.soft }]}>{member ? <Copy tone="label">{member.name.trim().slice(0, 1).toLocaleUpperCase()}</Copy> : <Users color={colors.primary} size={19} />}</View>
    <Copy tone="label">{member?.name ?? allLabel ?? "Everyone"}</Copy>
  </Pressable>
}

export function BoardTaskRow({ task, canEdit, memberNames, saving, needsAttention = false, onPress, onOpen, timezone }: { task: BoardTask; canEdit: boolean; memberNames: string; saving: boolean; needsAttention?: boolean; onPress: () => void; onOpen?: () => void; timezone?: string }) {
  const colors = usePalette()
  const complete = task.status === "completed"
  const locked = task.status === "locked"
  const explanation = taskWaitingLabel(task, timezone)
  const metadataMessage = task.metadata_sync === "rejected" ? "Task edit needs attention" : task.metadata_sync === "pending" ? "Task edit waiting to sync" : null
  const label = `${task.title}${task.occurrence_title ? `, ${task.occurrence_title}` : ""}${memberNames ? `, ${memberNames}` : ""}${explanation ? `, ${explanation}` : ""}${needsAttention ? ", saved change needs attention" : saving ? ", saved on this device, waiting to sync" : ""}${metadataMessage ? `, ${metadataMessage}` : ""}`
  const check = <View style={[boardStyles.check, { borderColor: complete ? colors.primary : colors.border, backgroundColor: complete ? colors.primary : colors.background }]}>
      {complete ? <Check size={23} color={colors.onPrimary} strokeWidth={3} /> : locked ? <LockKeyhole size={18} color={colors.muted} /> : null}
    </View>
  const body = <View style={{ flex: 1, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {task.is_reward ? <Gift size={18} color={colors.warning} /> : null}
        <Copy style={{ flex: 1, fontWeight: "600", textDecorationLine: complete ? "line-through" : "none", color: complete ? colors.muted : colors.text }}>{task.title}</Copy>
      </View>
      {!onOpen && task.description ? <Copy tone="muted" style={{ fontSize: 14, lineHeight: 20 }}>{task.description}</Copy> : null}
      <Copy tone="muted" style={{ fontSize: 13, lineHeight: 19 }}>{[task.occurrence_title, memberNames].filter(Boolean).join(" · ")}</Copy>
      {explanation ? <Copy tone="label" style={{ color: colors.muted }}>{explanation}</Copy> : null}
      {onOpen ? <Copy tone="label" style={{ color: colors.muted }}>{complete ? "Completed" : locked ? "Waiting" : "Ready"}{!canEdit && !locked ? " · View only" : ""} · Details</Copy> : null}
      {needsAttention ? <Copy tone="label" style={{ color: colors.danger }}>Saved change needs attention</Copy> : saving ? <Copy tone="label" style={{ color: colors.primary }}>Saved on this device</Copy> : null}
      {metadataMessage ? <Copy tone="label" style={{ color: task.metadata_sync === "rejected" ? colors.danger : colors.primary }}>{metadataMessage}</Copy> : null}
    </View>
  if (onOpen) return <View style={[boardStyles.task, { backgroundColor: colors.surface, borderColor: colors.border, padding: 12, gap: 8 }]}>
    <Pressable onPress={onPress} disabled={!canEdit || locked} accessibilityRole="checkbox" accessibilityLabel={label}
      accessibilityState={{ checked: complete, disabled: !canEdit || locked }} accessibilityHint={complete ? "Mark incomplete" : "Mark complete"}
      style={({ pressed }) => ({ minWidth: 52, minHeight: 52, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.65 : 1 })}>{check}</Pressable>
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Open details: ${label}${task.is_reward ? ", reward" : ""}. ${complete ? "Completed" : locked ? "Waiting" : "Ready"}${!canEdit && !locked ? ", view only" : ""}`}
      style={({ pressed }) => ({ flex: 1, padding: 6, minHeight: 52, opacity: pressed ? 0.65 : 1 })}>{body}</Pressable>
  </View>
  return <Pressable onPress={onPress} disabled={!canEdit || locked} accessibilityRole="checkbox" accessibilityLabel={label}
    accessibilityState={{ checked: complete, disabled: !canEdit || locked }} accessibilityHint={complete ? "Mark incomplete" : "Mark complete"}
    style={({ pressed }) => [boardStyles.task, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.75 : 1 }]}>{check}{body}</Pressable>
}

type BoardProps = { kiosk?: NativeKioskSession; onParentAccess?: () => void; notice?: ReactNode }
export default function BoardScreen(props: BoardProps) {
  const state = useBoard(), { controller } = useRuntime()
  const familyDisplay = Boolean(props.kiosk)
  // The family display sits outside tab navigation and remains visible until
  // unlocked. The Today tab separately observes its navigation focus.
  useEffect(() => {
    if (!familyDisplay) return
    controller.setBoardVisible(true)
    return () => controller.setBoardVisible(false)
  }, [familyDisplay, controller])
  if (state.loading) return <Loading />
  return <BoardWorkspace key={`${controller.accountId}:${state.board?.household.id}:${state.board?.household.role}:${props.kiosk?.id ?? "parent"}`} {...props} />
}

function BoardWorkspace({ kiosk, onParentAccess, notice }: BoardProps) {
  const state = useBoard()
  const { controller, store, syncPaused } = useRuntime()
  const colors = usePalette()
  const { width, height, fontScale } = useWindowDimensions()
  const wide = width >= 780 && width > height && fontScale < 1.6
  const [selectedMember, setMember] = useState<string | null>(null)
  const [filter, setFilter] = useState<BoardFilter>("active"), [search, setSearch] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [preferences, setPreferences] = useState(defaultBoardDisplay)
  const [displayOpen, setDisplayOpen] = useState(false), [activeTaskKey, setActiveTaskKey] = useState<string | null>(null)
  const [showHouseholds, setShowHouseholds] = useState(false)
  const board = state.board
  const householdId = board?.household.id, role = board?.household.role
  const [displayReady, setDisplayReady] = useState(Boolean(kiosk) || !householdId || role === "member")
  const [displayError, setDisplayError] = useState<string | null>(null), [displayAttempt, setDisplayAttempt] = useState(0)
  useEffect(() => {
    if (!householdId || kiosk || role === "member") return
    let cancelled = false
    void store.boardDisplay(controller.accountId, householdId).then(saved => {
      if (!cancelled) { setPreferences(saved); setDisplayReady(true); setDisplayError(null) }
    }).catch(cause => { if (!cancelled) setDisplayError(cause instanceof Error ? cause.message : "Unable to read display settings.") })
    return () => { cancelled = true }
  }, [store, controller.accountId, householdId, role, kiosk, displayAttempt])
  const access = board ? boardDisplayAccess(board, preferences, controller.accountId, kiosk) : { visibleMemberIds: [], editableMemberIds: [] }
  const members = (board?.members ?? []).filter(member => access.visibleMemberIds.includes(member.id))
  const memberId = members.some(member => member.id === selectedMember) ? selectedMember : null
  const ordered = useMemo(() => orderBoardTasks(board?.tasks ?? []), [board?.tasks])
  const tasks = ordered.filter(task => (kiosk ? task.assignee_ids : taskMembers(task, board?.household.leaderId ?? ""))
    .some(id => access.visibleMemberIds.includes(id) && (!memberId || id === memberId)))
  const visible = filterBoardTasks(tasks, filter, search)
  const completed = tasks.filter(task => task.status === "completed").length
  const rejected = state.pending.filter(change => change.state === "rejected")
  const rejectedTasks = new Set(rejected.filter(change => change.householdId === householdId).map(change => `${change.occurrenceId}:${change.taskId}`))
  const pending = new Set(state.pending.filter(change => change.householdId === householdId).map(change => `${change.occurrenceId}:${change.taskId}`))
  const activeTask = tasks.find(task => boardTaskKey(task) === activeTaskKey) ?? null
  const actor = (task: BoardTask) => board ? boardCompletionActor(board, task, controller.accountId, access, memberId, kiosk) : null
  const memberNames = (task: BoardTask) => members.filter(member => task.assignee_ids.includes(member.id)).map(member => member.name).join(", ")
  function toggle(key: string) {
    const latest = controller.getSnapshot().board
    if (!latest || latest.household.id !== householdId) return
    const task = latest.tasks.find(item => boardTaskKey(item) === key)
    if (!task) return
    const member = boardCompletionActor(latest, task, controller.accountId, boardDisplayAccess(latest, preferences, controller.accountId, kiosk), memberId, kiosk)
    if (member) void controller.setCompleted(task, member, task.status !== "completed")
  }
  async function saveDisplay(value: BoardDisplayPreferences) {
    if (!householdId) return
    setPreferences(await store.saveBoardDisplay(controller.accountId, householdId, value))
  }
  if (!displayReady) return displayError ? <View style={[styles.center, { backgroundColor: colors.background }]}>
    <Copy tone="heading">Display settings unavailable</Copy><Copy>{displayError}</Copy>
    <Action label="Try again" onPress={() => { setDisplayError(null); setDisplayAttempt(value => value + 1) }} />
    <Action secondary label="Reset this display to everyone" onPress={() => void saveDisplay(defaultBoardDisplay()).then(() => setDisplayReady(true)).catch(cause => setDisplayError(cause.message))} />
  </View> : <Loading label="Opening this display…" />
  const people = <>
    <Person member={null} allLabel={members.length === board?.members.length ? "Everyone" : "Shown members"} selected={memberId === null} onPress={() => setMember(null)} />
    {members.map(member => <Person key={member.id} member={member} selected={memberId === member.id} onPress={() => setMember(member.id)} />)}
  </>
  return <SafeAreaView edges={kiosk ? ["top", "left", "right", "bottom"] : ["top", "left", "right"]} style={{ flex: 1, backgroundColor: colors.background }}>
    <View style={[boardStyles.top, { borderBottomColor: colors.border }]}>
      <View style={{ flex: 1, gap: 3 }}><Copy tone="label" style={{ color: colors.primary, letterSpacing: 1.5 }}>{kiosk ? "FAMILY DISPLAY" : "CYNTCH"}</Copy>
        {kiosk ? <Copy tone="heading">{board?.household.name ?? "Family tasks"}</Copy> : <Pressable accessibilityRole="button" accessibilityLabel="Choose household" onPress={() => setShowHouseholds(value => !value)} style={styles.row}>
          <Copy tone="heading" style={{ flexShrink: 1 }}>{board?.household.name ?? "Your household"}</Copy><ChevronDown size={18} color={colors.muted} />
        </Pressable>}
      </View>
      {!kiosk ? <Pressable accessibilityRole="button" accessibilityLabel="Notification history" onPress={() => router.navigate("/notifications")} style={boardStyles.iconButton}><Bell color={colors.primary} size={22} /></Pressable> : null}
      {kiosk && onParentAccess ? <Action secondary label="Parent access" onPress={onParentAccess} /> : <Pressable accessibilityRole="button" accessibilityLabel="Refresh tasks" onPress={() => void controller.refresh()} style={boardStyles.iconButton}><RefreshCw color={colors.primary} size={22} /></Pressable>}
    </View>
    {notice}
    {showHouseholds && !kiosk ? <ScrollView style={{ maxHeight: height * 0.3 }} contentContainerStyle={{ padding: 16, gap: 8 }}>
      {state.households.map(household => <Action key={household.id} secondary label={household.name} onPress={() => {
        setShowHouseholds(false); setMember(null); void controller.selectHousehold(household.id).catch(error => Alert.alert("Unable to switch household", error.message))
      }} />)}
    </ScrollView> : null}
    {!state.online || state.pending.length > 0 ? <View accessibilityLiveRegion="polite" style={[boardStyles.notice, { backgroundColor: colors.soft }]}>
      {!state.online && !syncPaused ? <WifiOff size={17} color={colors.primary} /> : null}
      <Copy tone="label" style={{ flex: 1 }}>{rejected.length ? `${rejected.length} saved ${rejected.length === 1 ? "change needs" : "changes need"} ${kiosk ? "a parent’s attention" : "attention in Settings"}.` : state.pending.length
        ? `${state.pending.length} ${state.pending.length === 1 ? "change saved" : "changes saved"} on this device. ${syncPaused ? "Waiting to sync." : state.online ? "Syncing…" : "Will sync when connected."}`
        : syncPaused ? "Syncing is paused. Your task changes are saved on this device." : "You’re offline. You can still complete saved tasks."}</Copy>
    </View> : null}
    {state.error ? <View accessibilityRole="alert" style={boardStyles.notice}><Copy style={{ color: colors.danger, flex: 1 }}>{state.error}</Copy></View> : null}
    <View style={{ flex: 1, flexDirection: wide ? "row" : "column" }}>
      {wide ? <ScrollView keyboardShouldPersistTaps="handled" style={{ width: 240, flexGrow: 0, borderRightWidth: 1, borderRightColor: colors.border }} contentContainerStyle={{ padding: 20, gap: 12 }}><Copy tone="label">FAMILY</Copy>{people}
        {!kiosk && board && role !== "member" ? <Action secondary label="Display settings" onPress={() => setDisplayOpen(true)} /> : null}</ScrollView>
        : <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 16, gap: 10 }}>{people}</ScrollView>}
      <FlatList style={{ flex: 1 }} data={visible} keyExtractor={boardTaskKey} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 32, maxWidth: 1000, width: "100%", alignSelf: "center" }}
        refreshControl={<RefreshControl refreshing={state.refreshing} onRefresh={() => void controller.refresh()} tintColor={colors.primary} />}
        ListHeaderComponent={<View style={{ gap: 12, marginBottom: 8 }}><View style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between" }]}>
          <Copy tone={wide || (kiosk && width > height) ? "heading" : "title"} style={{ flexShrink: 1 }}>{memberId ? `${members.find(member => member.id === memberId)?.name}’s day` : "Together, today"}</Copy>
          {wide && tasks.length > 0 ? <Copy tone="muted">{completed} of {tasks.length} done</Copy> : null}
          </View>
          {!wide ? <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
            <Copy tone="muted">{tasks.length ? `${completed} of ${tasks.length} done` : "Small steps. More room for family."}</Copy>
            {!wide && !kiosk && board && role !== "member" ? <Action secondary label="Display settings" onPress={() => setDisplayOpen(true)} /> : null}
          </View> : null}
          <View style={[styles.row, { flexWrap: "wrap", gap: 8 }]}>{([["active", "To do"], ["unlocked", "Ready"], ["completed", "Completed"], ["all", "All"]] as const).map(([value, label]) =>
            <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: filter === value }} onPress={() => setFilter(value)}
              style={{ minHeight: 48, padding: 12, borderRadius: 12, justifyContent: "center", backgroundColor: filter === value ? colors.primary : colors.soft }}><Copy tone="label" style={{ color: filter === value ? colors.onPrimary : colors.text }}>{label}</Copy></Pressable>)}
            {wide ? <Pressable accessibilityRole="button" accessibilityLabel={searchOpen || search ? "Hide search" : "Search tasks"} accessibilityState={{ expanded: searchOpen || Boolean(search) }}
              onPress={() => { setSearchOpen(!(searchOpen || Boolean(search))); if (searchOpen || search) setSearch("") }} style={boardStyles.iconButton}><Search color={colors.primary} size={23} /></Pressable> : null}</View>
          {!wide || searchOpen || search ? <View style={styles.row}><TextInput accessibilityLabel="Find a task" placeholder="Find a task or routine…" placeholderTextColor={colors.muted} value={search} onChangeText={setSearch}
            autoCorrect={false} autoCapitalize="none" returnKeyType="search" maxLength={200} disableFullscreenUI
            style={{ flex: 1, minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, fontSize: 16, color: colors.text, backgroundColor: colors.surface }} />
            {search ? <Action secondary label="Clear search" onPress={() => setSearch("")} /> : null}</View> : null}
        </View>}
        ListEmptyComponent={<Card><Copy tone="heading">{tasks.length > 0 ? "No matching tasks" : board && !members.length ? "No members on this display" : board ? "Room for a fresh start" : kiosk ? "Family tasks are unavailable" : "Welcome to Cyntch"}</Copy>
          <Copy tone="muted">{tasks.length > 0 ? "Try another filter or clear your search." : board && !members.length ? kiosk ? "Ask a parent to check this display’s member settings." : "Choose household members in Display settings." : board ? "Active routines and tasks will appear here for your household." : kiosk ? "Ask a parent to check access to this household. Parent controls remain locked." : state.online ? "Create or join a household to start sharing routines." : "Connect once to load your household on this device."}</Copy>
          {tasks.length > 0 ? <Action secondary label="Show all tasks" onPress={() => { setSearch(""); setFilter("all") }} /> : null}
        </Card>}
        renderItem={({ item: task }) => {
          return <BoardTaskRow task={task} saving={pending.has(boardTaskKey(task))} needsAttention={rejectedTasks.has(boardTaskKey(task))} timezone={board?.household.timezone}
            memberNames={memberNames(task)} canEdit={Boolean(actor(task))} onOpen={() => setActiveTaskKey(boardTaskKey(task))} onPress={() => toggle(boardTaskKey(task))} />
        }}
      />
    </View>
    {activeTaskKey ? <BoardTaskDetails task={activeTask} memberNames={activeTask ? memberNames(activeTask) : ""} timezone={board?.household.timezone}
      canEdit={Boolean(activeTask && actor(activeTask))} saving={pending.has(activeTaskKey)} needsAttention={rejectedTasks.has(activeTaskKey)} kiosk={Boolean(kiosk)} onToggle={() => toggle(activeTaskKey)} onClose={() => setActiveTaskKey(null)} /> : null}
    {displayOpen && board && !kiosk && role !== "member" ? <BoardDisplaySettings board={board} accountId={controller.accountId} preferences={preferences} onSave={saveDisplay} onClose={() => setDisplayOpen(false)} /> : null}
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
