import { UserButton } from "@clerk/expo/native-components"
import { Alert, ScrollView, Switch, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Action, Card, Copy, styles, usePalette } from "../components/ui"
import { useBoard, useNotificationHistory, useNotifications, usePlanner, useRuntime } from "../providers/runtime"
import { PlannerPendingCreations } from "../components/planner-pending-creations"
import { NotificationSettingsCard } from "../components/notification-settings"
import { useNotificationSession } from "../providers/notification-session"
import { KioskSettingsCard } from "../components/kiosk-settings"
import { BillingSettingsCard } from "../components/billing-settings"

export default function SettingsScreen() {
  const { signOut } = useNotificationSession()
  const { controller, planner, keepAwake, setKeepAwake } = useRuntime()
  const state = useBoard()
  const planning = usePlanner()
  const notifications = useNotifications()
  const history = useNotificationHistory()
  const colors = usePalette()
  const rejected = state.pending.filter(change => change.state === "rejected")
  const savedCount = state.pending.length + planning.pending.length + planning.creations.length + notifications.pending.length + history.pending
  function report(error: unknown) { Alert.alert("Unable to update", error instanceof Error ? error.message : "Please try again.") }
  return <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: colors.background }}><ScrollView contentContainerStyle={styles.content}>
    <Copy tone="title">Settings</Copy>
    <Card><View style={styles.row}><UserButton /><View style={{ flex: 1 }}><Copy tone="heading">Your account</Copy><Copy tone="muted">Manage your profile and sign-in details.</Copy></View></View></Card>
    <BillingSettingsCard />
    <Card><Copy tone="heading">This device</Copy><View style={styles.row}><View style={{ flex: 1, gap: 4 }}><Copy>Keep the display awake</Copy><Copy tone="muted">While Cyntch is open. You can still lock the screen yourself.</Copy></View>
      <Switch accessibilityLabel="Keep the display awake while Cyntch is open" value={keepAwake} onValueChange={value => void setKeepAwake(value).catch(report)} trackColor={{ true: colors.primary }} />
    </View></Card>
    <KioskSettingsCard />
    <NotificationSettingsCard />
    <Card><Copy tone="heading">Saved changes</Copy><Copy tone="muted">{savedCount ? `${savedCount} ${savedCount === 1 ? "change is" : "changes are"} saved on this device and waiting to sync.` : "All saved changes have synced."}</Copy>
      {rejected.map(change => {
        const unavailable = !state.households.some(household => household.id === change.householdId)
        return <View key={change.id} style={{ gap: 12, paddingTop: 12, borderTopWidth: 1, borderColor: colors.border }}>
        <Copy>{state.board?.tasks.find(task => task.id === change.taskId)?.title ?? "Task update"}</Copy>
        <Copy style={{ color: colors.danger }}>{change.error}</Copy>
        {!unavailable ? <Action label="Try syncing again" onPress={() => void controller.retry(change).catch(report)} /> : null}
        <Action secondary disabled={!unavailable && !state.online} label={unavailable ? "Discard unavailable change" : "Use the household’s current version"} onPress={() => Alert.alert("Discard this saved change?", unavailable
          ? "You no longer have access to this household. This unsynced change will be removed from this device."
          : "The task will return to the household’s current version. Other saved changes will be kept.", [
          { text: "Cancel", style: "cancel" }, { text: "Discard change", style: "destructive", onPress: () => void controller.discard(change).catch(report) },
        ])} />
      </View>})}
      {planning.pending.filter(edit => edit.state === "rejected").map(edit => {
        const unavailable = !state.households.some(household => household.id === edit.householdId && household.role !== "member")
        return <View key={edit.id} style={{ gap: 12, paddingTop: 12, borderTopWidth: 1, borderColor: colors.border }}>
          <Copy>{edit.draft.title}</Copy><Copy style={{ color: colors.danger }}>{edit.error}</Copy>
          {!unavailable ? <Action label="Retry routine edit" onPress={() => void planner.retry(edit).catch(report)} /> : null}
          <Action secondary disabled={!unavailable && !state.online} label="Discard saved routine edit" onPress={() => Alert.alert("Discard this routine edit?", "This unsynced edit will be removed from this device.", [
            { text: "Cancel", style: "cancel" }, { text: "Discard edit", style: "destructive", onPress: () => void planner.discard(edit).catch(report) },
          ])} />
        </View>
      })}
      <PlannerPendingCreations />
    </Card>
    <Action secondary label="Sign out" onPress={() => Alert.alert("Sign out of Cyntch?", savedCount
      ? "Your unsynced changes will stay on this device. Sign back into this account to sync them." : "You can sign back in at any time.", [
      { text: "Cancel", style: "cancel" }, { text: "Sign out", onPress: () => void signOut().catch(report) },
    ])} />
  </ScrollView></SafeAreaView>
}
