import { ClerkProvider, useAuth } from "@clerk/expo"
import { AuthView } from "@clerk/expo/native-components"
import { tokenCache } from "@clerk/expo/token-cache"
import { nativeClerkResourceCache } from "../services/native-clerk-offline-cache"
import { Tabs } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useState } from "react"
import { Alert, Modal, ScrollView, View } from "react-native"
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context"
import { CircleCheck, History, ListChecks, Settings, Users } from "lucide-react-native"
import { Action, Copy, Loading, styles, usePalette } from "../components/ui"
import { RuntimeProvider } from "../providers/runtime"
import { NotificationSessionProvider, useNotificationSession } from "../providers/notification-session"
import { NotificationInteractions } from "../components/notification-interactions"
import { KioskProvider, useKiosk } from "../providers/kiosk"
import { KioskScreen } from "../components/kiosk-screen"
import { AccountDeletionRecoveryProvider, useAccountDeletionRecovery } from "../providers/account-deletion-recovery"
import { AccountDeletionStatusView } from "../components/account-deletion-status"
import { AccountDeletionRecoveryActions } from "../components/account-deletion-recovery-actions"
import { AccountDeletionRecoveryFallback } from "../components/account-deletion-recovery-fallback"

function Application() {
  const { isLoaded, isSignedIn, userId, sessionId } = useAuth({ treatPendingAsSignedOut: false })
  const [authOpen, setAuthOpen] = useState(false)
  const [recoveryOpen,setRecoveryOpen] = useState(false)
  const colors = usePalette()
  const kiosk = useKiosk(), { signOut } = useNotificationSession()
  const {state:deletion} = useAccountDeletionRecovery()
  if (!kiosk.state.ready || kiosk.state.changing) return <View style={{ flex: 1, backgroundColor: colors.background }}><Loading label={kiosk.state.changing ? "Protecting this device…" : "Checking this device…"} />
    {kiosk.state.error ? <View style={styles.content}><Copy>{kiosk.state.error}</Copy><Action label="Try again" onPress={() => void kiosk.controller.start()} /></View> : null}</View>
  const accepted = Boolean(userId && deletion.deletedAccounts.includes(userId))
  if (kiosk.state.record && kiosk.state.record.intent !== "unlock" && !(accepted && kiosk.state.record.kiosk.accountId === userId)) return <KioskScreen />
  if (isSignedIn && userId && (accepted || (deletion.record?.accountId === userId && deletion.record.submitted))) return <AccountDeletionRecoveryActions />
  return <>
    {kiosk.state.record ? <SafeAreaView edges={["top", "left", "right"]} style={{ backgroundColor: colors.soft }}><View style={{ padding: 16, gap: 8 }}>
      <Copy>Parent controls are unlocked on this device. {kiosk.state.online ? "Finishing sync…" : "Connect to finish syncing the unlock."}</Copy>
      {kiosk.state.error ? <Copy style={{ color: colors.danger }}>{kiosk.state.error}</Copy> : null}
      {kiosk.state.record.blocked || sessionId !== kiosk.state.record.kiosk.sessionId ? <Action label="Recover with parent sign-in" onPress={() => void kiosk.controller.beginRecovery().then(() => signOut()).catch(cause => Alert.alert("Parent sign-in needed", cause instanceof Error ? cause.message : "Connect and try again."))} /> : null}
    </View></SafeAreaView> : null}
    {!isLoaded ? <Loading label="Opening Cyntch…" /> : isSignedIn && userId && sessionId ? <RuntimeProvider key={`${userId}:${sessionId}:${Boolean(kiosk.state.record)}`} accountId={userId} sessionId={sessionId} canSync={!kiosk.state.record}>
      <Tabs screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.primary, tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border }, tabBarLabelStyle: { fontSize: 12 } }}>
        <Tabs.Screen name="index" options={{ title: "Today", tabBarIcon: ({ color, size }) => <CircleCheck color={color} size={size} /> }} />
        <Tabs.Screen name="routines" options={{ title: "Routines", tabBarIcon: ({ color, size }) => <ListChecks color={color} size={size} /> }} />
        <Tabs.Screen name="runs" options={{ title: "Runs", tabBarIcon: ({ color, size }) => <History color={color} size={size} /> }} />
        <Tabs.Screen name="household" options={{ title: "Household", tabBarIcon: ({ color, size }) => <Users color={color} size={size} /> }} />
        <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: ({ color, size }) => <Settings color={color} size={size} /> }} />
        {/* SDK 58 redirects hidden routes. Hide only the button so history remains navigable. */}
        <Tabs.Screen name="notifications" options={{ tabBarButton: () => null, tabBarItemStyle: { display: "none" } }} />
        <Tabs.Screen name="account-deletion" options={{ tabBarButton: () => null, tabBarItemStyle: { display: "none" } }} />
      </Tabs>
      {!kiosk.state.record ? <NotificationInteractions accountId={userId} sessionId={sessionId} /> : null}
    </RuntimeProvider> : <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
      <View style={{ maxWidth: 430, width: "100%", gap: 24 }}>
        <Copy tone="label" style={{ color: colors.primary, letterSpacing: 2 }}>CYNTCH</Copy>
        <Copy tone="title">A little more together.</Copy>
        <Copy tone="muted">Family routines, shared tasks and small wins. All in one place.</Copy>
        <Action label="Sign in or create an account" onPress={() => setAuthOpen(true)} />
        <Copy tone="muted">Children can use a parent’s device or the family tablet. They don’t need an email address.</Copy>
        {deletion.record ? <Action secondary label="Check saved account deletion" onPress={() => setRecoveryOpen(true)} /> : null}
      </View>
      </ScrollView>
    </SafeAreaView>}
    <Modal visible={authOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setAuthOpen(false)}>
      <AuthView onDismiss={() => setAuthOpen(false)} />
    </Modal>
    <Modal visible={recoveryOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setRecoveryOpen(false)}><AccountDeletionStatusView onClose={() => setRecoveryOpen(false)} /></Modal>
  </>
}

export default function RootLayout() {
  const key = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
  return <SafeAreaProvider><StatusBar style="auto" /><AccountDeletionRecoveryProvider>{key ? <ClerkProvider publishableKey={key} tokenCache={tokenCache} __experimental_resourceCache={nativeClerkResourceCache}>
    <KioskProvider><NotificationSessionProvider fallback={<AccountDeletionRecoveryFallback />}><Application /></NotificationSessionProvider></KioskProvider>
  </ClerkProvider> : <View style={styles.center}><Copy tone="heading">Cyntch setup is incomplete</Copy><Copy>This build is missing its sign-in configuration.</Copy></View>}</AccountDeletionRecoveryProvider></SafeAreaProvider>
}
