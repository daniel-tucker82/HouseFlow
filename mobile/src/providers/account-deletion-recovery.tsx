import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from "react"
import { AppState, ScrollView, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { useAuth } from "@clerk/expo"
import { useAuthViewState } from "@clerk/expo/native-components"
import type { AccountDeletionRecoveryController } from "../services/account-deletion-recovery"
import { nativeAccountDeletionRecovery } from "../services/native-account-deletion"
import { Action, Copy, Loading, usePalette } from "../components/ui"

const RecoveryContext = createContext<AccountDeletionRecoveryController | null>(null)

/** Outside Clerk: an expired/deleted identity cannot hide its recovery receipt. */
export function AccountDeletionRecoveryProvider({children}: PropsWithChildren) {
  const [controller,setController] = useState<AccountDeletionRecoveryController | null>(null)
  const [error,setError] = useState(false), [attempt,setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    void nativeAccountDeletionRecovery().then(value => { if (!cancelled) { setController(value);void value.refresh().catch(() => undefined) } }).catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  },[attempt])
  if (error) return <AccountRecoveryUnavailable onRetry={() => {setError(false);setAttempt(value => value+1)}} />
  if (!controller) return <Loading label="Opening saved account information…" />
  return <RecoveryContext value={controller}><RecoveryReady>{children}</RecoveryReady></RecoveryContext>
}
function RecoveryReady({children}: PropsWithChildren) {
  const {controller,state} = useAccountDeletionRecovery()
  if (!state.ready) {
    if (state.error && !state.busy) return <AccountRecoveryUnavailable onRetry={() => void controller.refresh().catch(() => undefined)} />
    return <Loading label="Checking saved account information…" />
  }
  return children
}
function AccountRecoveryUnavailable({onRetry}: {onRetry: () => void}) {
  const colors = usePalette()
  return <SafeAreaView style={{flex:1,backgroundColor:colors.background}}>
    <ScrollView contentContainerStyle={{flexGrow:1,justifyContent:"center",padding:24}}>
      <View style={{width:"100%",maxWidth:560,alignSelf:"center",gap:20}}>
        <Copy tone="heading">Cyntch couldn’t open</Copy>
        <Copy>We couldn’t read saved account information on this device. Try again, or close and reopen Cyntch.</Copy>
        <Action label="Try again" onPress={onRetry} />
      </View>
    </ScrollView>
  </SafeAreaView>
}
/** Mounted inside Clerk, independently of the signed-in application runtime.
 * Retry on readiness, identity and foreground transitions, including dismissed
 * receipts. No polling or dependency on cleanup's own busy/error publications. */
export function AccountDeletionIdentityRecovery() {
  const {controller} = useAccountDeletionRecovery()
  const {isLoaded,isAuthFlowComplete} = useAuthViewState()
  const {userId,sessionId} = useAuth({treatPendingAsSignedOut:false})
  useEffect(() => {
    if (!isLoaded) return
    const recover = () => {
      const state = controller.getSnapshot()
      if (state.record?.status || state.deletedAccounts.length) void controller.recoverIdentity().catch(() => undefined)
    }
    recover()
    let previous = AppState.currentState
    const subscription = AppState.addEventListener("change", next => {
      const becameActive = next === "active" && previous !== "active"
      previous = next
      if (becameActive) recover()
    })
    return () => subscription.remove()
  },[controller,isLoaded,isAuthFlowComplete,userId,sessionId])
  return null
}
export function useAccountDeletionRecovery() {
  const controller = useContext(RecoveryContext)
  if (!controller) throw new Error("Account recovery is not available")
  const state = useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot)
  return {controller,state}
}
