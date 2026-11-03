import { useCallback, useState } from "react"
import { router, useFocusEffect } from "expo-router"
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, useWindowDimensions, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import type { NotificationHistoryItem } from "../../../shared/mobile/notification-history"
import { useNotificationHistory, useRuntime } from "../providers/runtime"
import { Action, Card, Copy, styles, usePalette } from "../components/ui"

function report(error: unknown) { Alert.alert("Notification unavailable", error instanceof Error ? error.message : "Please try again.") }
function when(time: string) { return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) }

export default function NotificationHistoryScreen() {
  const { history, runs } = useRuntime(), state = useNotificationHistory(), colors = usePalette()
  const { width, height, fontScale } = useWindowDimensions(), wide = width >= 740 && width > height && fontScale < 1.5
  const [selected, setSelected] = useState<{ source: string; householdId: string; id: string } | null>(null)
  const [opening, setOpening] = useState(false)
  useFocusEffect(useCallback(() => { history.setVisible(true); return () => history.setVisible(false) }, [history]))
  const items = state.page?.items ?? []
  const detail = selected?.source === state.source && selected.householdId === state.household?.id ? items.find(item => item.id === selected.id) : null
  const change = (action: "read" | "dismiss" | "readAll" | "dismissAll", id?: string) => void history.change(action, id).catch(report)
  const open = async (item: NotificationHistoryItem) => {
    setOpening(true)
    try {
      const target = await history.prepareOpen(item.id)
      if (target.occurrenceId) { router.navigate("/runs"); void runs.openRun(target.occurrenceId, target.taskId).catch(report) }
      else router.navigate("/household")
    } catch (error) { report(error) } finally { setOpening(false) }
  }
  const header = <View style={{ gap: 16, paddingBottom: 20 }}>
    <View style={[styles.row, { flexWrap: "wrap" }]}><Copy tone="title" style={{ flex: 1, minWidth: 200 }}>Notifications</Copy>
      <Action secondary label="Settings" onPress={() => router.navigate("/settings")} /></View>
    <Copy tone="heading">{state.household?.name ?? "Choose a household in Today"}</Copy>
    <View accessibilityRole="tablist" style={styles.row}>
      {(["app", "web"] as const).map(source => <Pressable key={source} accessibilityRole="tab" accessibilityState={{ selected: state.source === source }}
        onPress={() => history.selectSource(source)} style={[styles.action, { flex: 1, backgroundColor: state.source === source ? colors.primary : colors.soft }]}>
        <Copy tone="label" style={{ textAlign: "center", color: state.source === source ? colors.onPrimary : colors.text }}>{source === "app" ? "App" : "Website"}</Copy>
      </Pressable>)}
    </View>
    <Copy tone="muted">{state.source === "app" ? "Events matching this device’s categories and members. Quiet hours silence alerts, not history."
      : "Notifications from your website preferences. Read and dismissed states are shared with the website."}</Copy>
    {!state.online ? <Copy tone="muted">You’re offline. {state.page ? `Showing history saved ${when(state.page.fetchedAt)}. Read and dismiss changes will sync when connected.` : "Connect to load this history for the first time."}</Copy> : null}
    {state.waitingForSettings ? <Copy tone="muted">Waiting for this device’s notification choices to sync.</Copy> : null}
    {state.pending ? <Copy tone="muted">{state.pending} {state.pending === 1 ? "change" : "changes"} saved on this device, waiting to sync.</Copy> : null}
    {state.syncError ? <View accessibilityRole="alert" style={{ gap: 8 }}><Copy style={{ color: colors.warning }}>{state.syncError}</Copy>
      <Action secondary label="Retry saved notification changes" disabled={!state.online || state.loading} onPress={() => void history.refresh()} /></View> : null}
    {state.error ? <View accessibilityRole="alert" style={{ gap: 8 }}><Copy style={{ color: colors.danger }}>{state.error}</Copy>
      <Action secondary label="Retry history" disabled={!state.online || state.loading} onPress={() => void history.refresh()} /></View> : null}
    {items.length ? <View style={[styles.row, { flexWrap: "wrap" }]}>
      <Action secondary label="Mark all read" disabled={state.saving || items.every(item => item.read)} onPress={() => change("readAll")} />
      <Action secondary label="Clear history" disabled={state.saving} onPress={() => Alert.alert("Clear this notification history?", state.source === "app"
        ? "This clears all app history for this household on this device up to the last refresh, including older pages and disabled categories. Newer notifications will remain. Tasks and routines are unchanged."
        : "This clears your website notifications for this household up to the last refresh, including older pages. Newer notifications will remain. Tasks and routines are unchanged.", [
        { text: "Cancel", style: "cancel" }, { text: "Clear history", style: "destructive", onPress: () => change("dismissAll") },
      ])} />
    </View> : null}
  </View>
  return <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: colors.background }}>
    <View style={{ flex: 1, flexDirection: wide ? "row" : "column", width: "100%", maxWidth: 1200, alignSelf: "center" }}>
      <FlatList style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 12 }} data={items} keyExtractor={item => item.id}
        ListHeaderComponent={header} refreshing={state.loading} onRefresh={() => void history.refresh()}
        ListEmptyComponent={<Card><Copy tone="heading">{state.loading ? "Loading notifications…" : state.error ? "History unavailable" : !state.online && !state.page ? "No saved history" : "No notifications here yet"}</Copy>
          <Copy tone="muted">{state.source === "app" ? "Choose event types and family members in notification settings. Matching household updates will appear here." : "Your website notifications will appear here when available."}</Copy></Card>}
        ListFooterComponent={state.page?.nextCursor ? <Action secondary disabled={!state.online || state.loading} label={state.loading ? "Loading…" : "Load older notifications"} onPress={() => void history.loadMore()} /> : undefined}
        renderItem={({ item }) => <Card style={detail?.id === item.id ? { borderColor: colors.primary, borderWidth: 2 } : undefined}>
          <Copy tone="label" style={{ color: colors.primary }}>{item.read ? "Read" : "Unread"} · {when(item.createdAt)}</Copy>
          <Copy tone="heading">{item.title}</Copy><Copy>{item.body}</Copy>
          {wide ? <Action secondary label="View notification" onPress={() => setSelected({ source: state.source, householdId: state.household!.id, id: item.id })} />
            : <HistoryActions item={item} online={state.online} busy={state.saving || opening} open={() => void open(item)} change={change} />}
        </Card>} />
      {wide ? <ScrollView style={{ flex: 0.8, borderLeftWidth: 1, borderColor: colors.border }} contentContainerStyle={{ padding: 20, gap: 16 }}>
        {detail ? <><Copy tone="label">{when(detail.createdAt)}</Copy><Copy tone="title">{detail.title}</Copy><Copy>{detail.body}</Copy>
          <HistoryActions item={detail} online={state.online} busy={state.saving || opening} open={() => void open(detail)} change={change} />
        </> : <><Copy tone="heading">Household updates</Copy><Copy tone="muted">Select a notification to see its details and open the related task or routine.</Copy></>}
      </ScrollView> : null}
    </View>
    {opening ? <View accessibilityRole="alert" style={{ padding: 12 }}><ActivityIndicator color={colors.primary} /><Copy tone="muted">Checking household access…</Copy></View> : null}
  </SafeAreaView>
}

function HistoryActions({ item, online, busy, open, change }: { item: NotificationHistoryItem; online: boolean; busy: boolean; open: () => void; change: (action: "read" | "dismiss", id: string) => void }) {
  return <View style={{ gap: 10 }}>
    <Action label={item.taskId ? "Open task" : item.occurrenceId ? "Open routine" : "Open household"} disabled={!online || busy} onPress={open} />
    <View style={[styles.row, { flexWrap: "wrap" }]}>{!item.read ? <Action secondary label="Mark read" disabled={busy} onPress={() => change("read", item.id)} /> : null}
      <Action secondary label="Dismiss" disabled={busy} onPress={() => change("dismiss", item.id)} /></View>
  </View>
}
