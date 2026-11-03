import { ClerkProvider, useAuth } from "@clerk/expo"
import { AuthView } from "@clerk/expo/native-components"
import { tokenCache } from "@clerk/expo/token-cache"
import { resourceCache } from "@clerk/expo/resource-cache"
import { Tabs } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useState } from "react"
import { Modal, ScrollView, View } from "react-native"
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context"
import { CircleCheck, History, ListChecks, Settings, Users } from "lucide-react-native"
import { Action, Copy, Loading, styles, usePalette } from "../components/ui"
import { RuntimeProvider } from "../providers/runtime"
import { NotificationSessionProvider } from "../providers/notification-session"

function Application() {
  const { isLoaded, isSignedIn, userId, sessionId } = useAuth({ treatPendingAsSignedOut: false })
  const [authOpen, setAuthOpen] = useState(false)
  const colors = usePalette()
  return <>
    {!isLoaded ? <Loading label="Opening Cyntch…" /> : isSignedIn && userId && sessionId ? <RuntimeProvider key={`${userId}:${sessionId}`} accountId={userId} sessionId={sessionId}>
      <Tabs screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.background },
        tabBarActiveTintColor: colors.primary, tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border }, tabBarLabelStyle: { fontSize: 12 } }}>
        <Tabs.Screen name="index" options={{ title: "Today", tabBarIcon: ({ color, size }) => <CircleCheck color={color} size={size} /> }} />
        <Tabs.Screen name="routines" options={{ title: "Routines", tabBarIcon: ({ color, size }) => <ListChecks color={color} size={size} /> }} />
        <Tabs.Screen name="runs" options={{ title: "Runs", tabBarIcon: ({ color, size }) => <History color={color} size={size} /> }} />
        <Tabs.Screen name="household" options={{ title: "Household", tabBarIcon: ({ color, size }) => <Users color={color} size={size} /> }} />
        <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: ({ color, size }) => <Settings color={color} size={size} /> }} />
      </Tabs>
    </RuntimeProvider> : <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
      <View style={{ maxWidth: 430, width: "100%", gap: 24 }}>
        <Copy tone="label" style={{ color: colors.primary, letterSpacing: 2 }}>CYNTCH</Copy>
        <Copy tone="title">A little more together.</Copy>
        <Copy tone="muted">Family routines, shared tasks and small wins. All in one place.</Copy>
        <Action label="Sign in or create an account" onPress={() => setAuthOpen(true)} />
        <Copy tone="muted">Children can use a parent’s device or the family tablet. They don’t need an email address.</Copy>
      </View>
      </ScrollView>
    </SafeAreaView>}
    <Modal visible={authOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setAuthOpen(false)}>
      <AuthView onDismiss={() => setAuthOpen(false)} />
    </Modal>
  </>
}

export default function RootLayout() {
  const key = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY
  return <SafeAreaProvider><StatusBar style="auto" />{key ? <ClerkProvider publishableKey={key} tokenCache={tokenCache} __experimental_resourceCache={resourceCache}>
    <NotificationSessionProvider><Application /></NotificationSessionProvider>
  </ClerkProvider> : <View style={styles.center}><Copy tone="heading">Cyntch setup is incomplete</Copy><Copy>This build is missing its sign-in configuration.</Copy></View>}</SafeAreaProvider>
}
