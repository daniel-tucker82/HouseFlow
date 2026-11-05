import { UserButton } from "@clerk/expo/native-components"
import { Alert, ScrollView, Switch, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Action, Card, Copy, styles, usePalette } from "../components/ui"
import { useBoard, useNotificationHistory, useNotifications, usePlanner, useRunEditor, useRuntime } from "../providers/runtime"
import { PlannerPendingCreations } from "../components/planner-pending-creations"
import { NotificationSettingsCard } from "../components/notification-settings"
import { useNotificationSession } from "../providers/notification-session"
import { KioskSettingsCard } from "../components/kiosk-settings"
import { BillingSettingsCard } from "../components/billing-settings"
import { useRouter } from "expo-router"
import { AccountCleanupNotice } from "../components/account-cleanup-notice"
import { PolicyLinks } from "../components/policy-links"
import { policyLinks } from "../services/policy-links"

export default function SettingsScreen() {
  const router = useRouter()
  const { signOut } = useNotificationSession()
  const { controller, planner, runEditor, history: historyController, keepAwake, setKeepAwake } = useRuntime()
  const state = useBoard()
  const planning = usePlanner()
  const live = useRunEditor()
  const notifications = useNotifications()
  const history = useNotificationHistory()
  const colors = usePalette()
  const rejected = state.pending.filter(change => change.state === "rejected")
  const savedChanges = [...state.pending, ...planning.pending, ...planning.creations, ...live.pending, ...notifications.pending]
  const savedCount = savedChanges.length + history.pending
  const needsAttention = savedChanges.filter(change => change.state === "rejected").length
  function report(error: unknown) { Alert.alert("Unable to update", error instanceof Error ? error.message : "Please try again.") }
  return <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: colors.background }}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Copy tone="title">Settings</Copy>
    <AccountCleanupNotice />
    <Card><View style={styles.row}><UserButton /><View style={{ flex: 1 }}><Copy tone="heading">Your account</Copy><Copy tone="muted">Manage your profile and sign-in details.</Copy></View></View></Card>
    <Action secondary label="Review account deletion" onPress={() => router.navigate("/account-deletion")} />
    {policyLinks.privacy || policyLinks.terms ? <Card><Copy tone="heading">Privacy and terms</Copy><PolicyLinks /></Card> : null}
    <BillingSettingsCard />
    <Card><Copy tone="heading">This device</Copy><View style={styles.row}><View style={{ flex: 1, gap: 4 }}><Copy>Keep the display awake</Copy><Copy tone="muted">While Cyntch is open. You can still lock the screen yourself.</Copy></View>
      <Switch accessibilityLabel="Keep the display awake while Cyntch is open" value={keepAwake} onValueChange={value => void setKeepAwake(value).catch(report)} trackColor={{ true: colors.primary }} />
    </View></Card>
    <KioskSettingsCard />
    <NotificationSettingsCard />
    <Card><Copy tone="heading">Saved changes</Copy><Copy tone="muted">{savedCount ? `${savedCount} ${savedCount === 1 ? "change is" : "changes are"} saved on this device and ${savedCount === 1 ? "has" : "have"} not synced.` : "All saved changes have synced."}</Copy>
      {needsAttention ? <Copy style={{ color: colors.warning }}>{needsAttention} saved {needsAttention === 1 ? "change needs" : "changes need"} attention.</Copy> : null}
      {history.syncError ? <View style={{ gap: 8 }}><Copy style={{ color: colors.warning }}>{history.syncError}</Copy>
        <Action secondary label="Retry saved notification changes" disabled={!state.online} onPress={() => void historyController.refresh()} /></View> : null}
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
      {live.pending.map(edit => {
        const household = state.households.find(item => item.id === edit.householdId)
        const unavailable = !household || household.role === "member"
        const needsConnection = !unavailable && !live.online && !edit.draft.isNew
        return <View key={edit.id} style={{ gap: 12, paddingTop: 12, borderTopWidth: 1, borderColor: colors.border }}>
          <Copy tone="label">{edit.draft.title}</Copy>
          <Copy tone="muted">Task edit · {household?.name ?? "Unavailable household"}</Copy>
          <Copy style={{ color: edit.state === "rejected" ? colors.danger : colors.muted }}>{edit.state === "rejected" ? edit.error : "Saved on this device. Waiting to sync."}</Copy>
          {edit.state === "rejected" ? <>
            {!unavailable ? <Action secondary label="Try syncing task again" disabled={!live.online} onPress={() => void runEditor.retry(edit).catch(report)} /> : null}
            {needsConnection ? <Copy tone="muted">Reconnect to refresh this task before discarding its saved edit.</Copy> : null}
            <Action secondary label="Discard saved task change" disabled={needsConnection} onPress={() => Alert.alert("Discard this saved task change?", "This removes the saved change from this device. It does not delete a task already saved in the household.", [
              { text: "Keep change", style: "cancel" }, { text: "Discard", style: "destructive", onPress: () => void runEditor.discard(edit).catch(report) },
            ])} />
          </> : null}
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
