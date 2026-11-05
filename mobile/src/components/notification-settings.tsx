import { useEffect, useState } from "react"
import { Alert, AppState, Platform, Pressable, ScrollView, Switch, View } from "react-native"
import { AppModal } from "./app-modal"
import { SafeAreaView } from "react-native-safe-area-context"
import { Check } from "lucide-react-native"
import { router } from "expo-router"
import { notificationCatalog, type MobileNotificationKind } from "../../../shared/mobile/notification-catalog"
import { useBoard, useNotifications, useRuntime } from "../providers/runtime"
import type { ChannelRestrictions } from "../services/notification-device"
import { PlannerDateTime } from "./planner-inputs"
import { Action, Card, Copy, styles, usePalette } from "./ui"

function report(error: unknown) { Alert.alert("Unable to update notifications", error instanceof Error ? error.message : "Please try again.") }
function Toggle({ label, detail, value, onChange }: { label: string; detail?: string; value: boolean; onChange: (value: boolean) => void }) {
  const colors = usePalette()
  return <View style={styles.row}><View style={{ flex: 1, gap: 4 }}><Copy>{label}</Copy>{detail ? <Copy tone="muted">{detail}</Copy> : null}</View>
    <Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: colors.primary }} /></View>
}

export function NotificationSettingsCard() {
  const [open, setOpen] = useState(false), state = useNotifications(), colors = usePalette()
  return <Card><Copy tone="heading">Notifications</Copy><Copy tone="muted">Choose alerts for this device, by event and family member.</Copy>
    <Copy>{state.permission === "denied" ? "Notifications aren’t allowed yet" : state.device?.hasToken ? "This device is registered" : "This device is not receiving push notifications yet"}</Copy>
    <Action secondary label="Choose notifications" onPress={() => setOpen(true)} />
    <Action secondary label="Notification history" onPress={() => router.navigate("/notifications")} />
    <AppModal visible={open} animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape-left", "landscape-right"]} onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>{open ? <NotificationSettings onClose={() => setOpen(false)} /> : null}</SafeAreaView>
    </AppModal>
  </Card>
}

function NotificationSettings({ onClose }: { onClose: () => void }) {
  const { notifications } = useRuntime(), state = useNotifications(), board = useBoard(), colors = usePalette()
  const prefs = state.preferences, household = state.household
  useEffect(() => { void notifications.refresh() }, [notifications])
  const [restrictions, setRestrictions] = useState<ChannelRestrictions>({})
  useEffect(() => {
    if (Platform.OS !== "android" || state.permission !== "granted") return
    let revision = 0
    const read = () => {
      const current = ++revision
      void notifications.channelRestrictions().then(value => { if (current === revision) setRestrictions(value) })
        .catch(() => { if (current === revision) setRestrictions({}) })
    }
    read()
    const subscription = AppState.addEventListener("change", value => { if (value === "active") read() })
    return () => { revision++; subscription.remove() }
  }, [notifications, state.permission])
  const change: typeof notifications.changePreferences = update => notifications.changePreferences(update).catch(report)
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const selectedPending = state.pending.filter(row => row.scope === "device" || row.scope === household?.id)
  return <ScrollView contentContainerStyle={[styles.content, { maxWidth: 800 }]}>
    <View style={[styles.row, { flexWrap: "wrap" }]}><Copy tone="heading" style={{ flex: 1, minWidth: 200 }}>Notifications</Copy><Action secondary label="Close notifications" onPress={onClose} /></View>
    <Card><Copy tone="heading">Device permission</Copy>
      <Copy>{state.permission === "granted" ? "Notifications are allowed by this device." : state.permission === "provisional" ? "Notifications can appear quietly. Allow alerts in device settings for banners and sounds." : state.permission === "denied" ? "Notifications aren’t allowed yet. Your choices below are kept." : "Allow Cyntch to show notification banners and alerts on this device."}</Copy>
      {state.iosPresentation?.alertsOff ? <Copy>Device settings have turned off banners for Cyntch.</Copy> : null}
      {state.iosPresentation?.centerOff ? <Copy>Cyntch alerts are hidden from Notification Center in device settings.</Copy> : null}
      {state.permission === "undetermined" || (state.permission === "denied" && state.canAskAgain) ? <Action disabled={state.checkingPermission} label={state.checkingPermission ? "Checking permission…" : "Allow device notifications"} onPress={() => void notifications.refreshDevice(true)} />
        : <Action secondary label="Open Cyntch’s device settings" onPress={() => void notifications.openSystemSettings().catch(report)} />}
      {state.permissionError ? <Copy style={{ color: colors.warning }}>{state.permissionError}</Copy> : null}
      {state.permission === "granted" && !state.device?.hasToken ? <><Copy tone="muted">Waiting to register this device for push notifications.</Copy><Action secondary label="Retry device registration" disabled={!board.online || state.checkingPermission} onPress={() => void notifications.refreshDevice()} /></> : null}
    </Card>
    {state.error ? <Copy style={{ color: colors.danger }}>{state.error}</Copy> : null}
    {!board.online ? <Copy tone="muted">You’re offline. Changes are saved on this device and will sync when connected.</Copy> : null}
    <Copy tone="muted">Changes save automatically on this device and sync when connected.</Copy>
    {selectedPending.filter(row => row.state === "rejected").map(row => <Card key={row.scope}><Copy tone="heading">A saved choice needs review</Copy><Copy>{row.error}</Copy>
      <Action label={row.scope === "device" ? "Retry device registration" : "Save the choices shown here"} disabled={!board.online} onPress={() => void notifications.review(row.scope).catch(report)} />
      <Action secondary label="Use the server’s current choices" disabled={!board.online} onPress={() => void notifications.review(row.scope, true).catch(report)} />
    </Card>)}
    {!household || !prefs ? <Card><Copy>Choose a household in Today to set its notification preferences.</Copy></Card> : <>
      <Copy tone="heading">{household.name}</Copy><Copy tone="muted">These choices apply only to this device and this household.</Copy>
      <Card><Toggle label="Receive notifications for this household" value={prefs.enabled} onChange={enabled => void change(current => ({ ...current, enabled }))} />
        <Toggle label="Show task and member details" detail="When off, notifications use a private, general message." value={prefs.showDetails} onChange={showDetails => void change(current => ({ ...current, showDetails }))} />
      </Card>
      <Card><Toggle label="Quiet hours" value={Boolean(prefs.quietHours)} onChange={enabled => void change(current => ({ ...current, timezone: localTimezone, quietHours: enabled ? { start: "22:00", end: "07:00" } : null }))} />
        {prefs.quietHours ? <><PlannerDateTime mode="time" label="Quiet hours start" value={prefs.quietHours.start} onChange={start => void change(current => ({ ...current, quietHours: { start, end: current.quietHours?.end ?? "07:00" } }))} />
          <PlannerDateTime mode="time" label="Quiet hours end" value={prefs.quietHours.end} onChange={end => void change(current => ({ ...current, quietHours: { start: current.quietHours?.start ?? "22:00", end } }))} />
          <Copy tone="muted">Times use {prefs.timezone}. {prefs.quietHours.start === prefs.quietHours.end ? "Matching times silence notifications all day." : "Notifications are silenced during these hours."}</Copy>
          {prefs.timezone !== localTimezone ? <Action secondary label={`Use this device’s timezone (${localTimezone})`} onPress={() => void change(current => ({ ...current, timezone: localTimezone }))} /> : null}</> : null}
      </Card>
      {(Object.keys(notificationCatalog) as MobileNotificationKind[]).filter(kind => {
        const category = notificationCatalog[kind]
        return (!category.managementOnly || household.role === "manager") && (category.scope !== "household" || household.role !== "member")
      }).map(kind => <NotificationCategory key={kind} kind={kind} restriction={state.permission === "granted" ? restrictions[kind] : undefined} />)}
    </>}
    <Action secondary label="Done" onPress={onClose} />
  </ScrollView>
}

function NotificationCategory({ kind, restriction }: { kind: MobileNotificationKind; restriction?: ChannelRestrictions[MobileNotificationKind] }) {
  const { notifications, controller } = useRuntime(), state = useNotifications(), colors = usePalette()
  const category = notificationCatalog[kind], selection = state.preferences?.categories[kind] ?? { enabled: false, memberIds: [] }
  const members = state.members.filter(member => state.household?.role !== "member" || member.id === controller.accountId)
  const change: typeof notifications.changePreferences = update => notifications.changePreferences(update).catch(report)
  return <Card><Toggle label={category.label} value={selection.enabled} onChange={enabled => void change(current => ({ ...current, categories: { ...current.categories, [kind]: {
    enabled, memberIds: current.categories[kind]?.memberIds ?? (category.scope === "member" ? [controller.accountId] : []),
  } } }))} />
    {restriction && selection.enabled && state.preferences?.enabled ? <>
      <Copy>{restriction === "blocked" ? "Android has turned off this alert type on this device." : "Android gives this alert a lower priority. It may appear without a banner."}</Copy>
      <Action secondary label={`Android settings: ${category.label}`} onPress={() => void notifications.openSystemSettings(kind).catch(report)} />
    </> : null}
    {category.scope === "member" && selection.enabled ? <><Copy tone="label">Notify me about</Copy><View style={{ gap: 8 }}>
      {members.map(member => <Pressable key={member.id} accessibilityRole="checkbox" accessibilityLabel={`${category.label}: ${member.name}`} accessibilityState={{ checked: selection.memberIds.includes(member.id) }}
        onPress={() => void change(current => { const currentSelection = current.categories[kind] ?? { enabled: true, memberIds: [] }; return { ...current, categories: { ...current.categories, [kind]: { ...currentSelection,
          memberIds: currentSelection.memberIds.includes(member.id) ? currentSelection.memberIds.filter(id => id !== member.id) : [...currentSelection.memberIds, member.id],
        } } } })} style={[styles.row, { minHeight: 48, borderRadius: 12, padding: 12, backgroundColor: selection.memberIds.includes(member.id) ? colors.soft : colors.background }]}>
        <Copy style={{ flex: 1 }}>{member.name}{member.id === controller.accountId ? " (me)" : ""}</Copy>{selection.memberIds.includes(member.id) ? <Check color={colors.primary} size={22} /> : null}
      </Pressable>)}
    </View>{!selection.memberIds.length ? <Copy style={{ color: colors.warning }}>Choose at least one person to receive these notifications.</Copy> : null}</> : null}
  </Card>
}
