import { useAuth } from "@clerk/expo"
import { AuthView } from "@clerk/expo/native-components"
import { useState } from "react"
import { Alert, Modal, ScrollView, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { useKiosk } from "../providers/kiosk"
import { useNotificationSession } from "../providers/notification-session"
import { RuntimeProvider } from "../providers/runtime"
import { KioskPinError } from "../storage/kiosk-pin-vault"
import { Action, Copy, styles, usePalette } from "./ui"
import { ParentPinInput } from "./kiosk-settings"
import BoardScreen from "./board-screen"

export function KioskScreen() {
  const { controller, state } = useKiosk(), { userId, sessionId, isSignedIn } = useAuth({ treatPendingAsSignedOut: false })
  const { signOut } = useNotificationSession(), colors = usePalette()
  const [pinOpen, setPinOpen] = useState(false), [pin, setPin] = useState(""), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), [authOpen, setAuthOpen] = useState(false)
  const record = state.record
  if (!record) return null
  const kiosk = record.kiosk
  const originalSignIn = isSignedIn && userId === kiosk.accountId && sessionId === kiosk.sessionId
  const canSync = Boolean(originalSignIn && !record.activationPending && record.intent === "lock")
  const needsAttention = record.activationPending && record.intent === "lock" || state.error || record.intent === "recover" || !originalSignIn
  const closePin = () => { setPinOpen(false); setPin(""); setError(null) }
  async function unlock() {
    setBusy(true); setError(null)
    try { await controller.unlock(pin); closePin() }
    catch (cause) { setPin(""); setError(cause instanceof KioskPinError && cause.retryAfterMs > 0 ? `${cause.message} Try again in ${Math.ceil(cause.retryAfterMs / 1000)} seconds.` : cause instanceof Error ? cause.message : "Unable to unlock.") }
    finally { setBusy(false) }
  }
  async function recover() {
    try {
      await controller.beginRecovery(); closePin()
      if (isSignedIn) await signOut()
      else setAuthOpen(true)
    } catch (cause) { Alert.alert("Parent sign-in needed", cause instanceof Error ? cause.message : "Connect and try again.") }
  }
  return <View style={{ flex: 1, backgroundColor: colors.background }}>
    <RuntimeProvider key={`${kiosk.id}:${canSync}`} accountId={kiosk.accountId} sessionId={kiosk.sessionId} restricted canSync={canSync}>
      <BoardScreen kiosk={kiosk} onParentAccess={() => { setPin(""); setError(null); setPinOpen(true) }} notice={needsAttention ? <View style={{ backgroundColor: colors.soft, paddingHorizontal: 20, paddingVertical: 12, gap: 10 }}>
      {record.activationPending && record.intent === "lock" ? <Copy tone="muted">{record.blocked ? "Setup needs a parent’s attention." : "Finishing secure setup. Please keep Cyntch open until this message disappears."}</Copy> : null}
      {state.error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{state.error}</Copy><Action secondary label="Try syncing again" onPress={() => void controller.retry()} /></View> : null}
      {record.intent === "recover" || !originalSignIn ? <><Copy tone="muted">Sign in with the parent account that enabled this display to restore syncing and parent controls. Saved tasks remain available.</Copy>
        <Action label={state.syncing ? "Recovering access…" : isSignedIn ? "Sign in again as the parent" : "Sign in as the parent"} disabled={!state.online || state.syncing} onPress={() => void recover()} /></> : null}
    </View> : null} />
    </RuntimeProvider>
    <Modal visible={pinOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={closePin}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Copy tone="title">Parent access</Copy><Copy tone="muted">Enter the PIN for this device to unlock Cyntch’s parent controls.</Copy>
        {record.intent !== "recover" ? <><ParentPinInput label="Parent PIN" value={pin} onChange={setPin} />
          {error ? <Copy style={{ color: colors.danger }}>{error}</Copy> : null}
          <Action label={busy ? "Checking PIN…" : "Unlock parent controls"} disabled={pin.length !== 6 || busy} onPress={() => void unlock()} /></> : null}
        <Action secondary label="Forgot PIN? Sign in as parent" disabled={busy} onPress={() => void recover()} />
        <Action secondary label="Back to family tasks" disabled={busy} onPress={closePin} />
      </ScrollView></SafeAreaView>
    </Modal>
    <Modal visible={authOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setAuthOpen(false)}><AuthView onDismiss={() => setAuthOpen(false)} /></Modal>
  </View>
}
