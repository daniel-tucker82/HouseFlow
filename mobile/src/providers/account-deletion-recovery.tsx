import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from "react"
import { AppState, View } from "react-native"
import { useAuth } from "@clerk/expo"
import { useAuthViewState } from "@clerk/expo/native-components"
import type { AccountDeletionRecoveryController } from "../services/account-deletion-recovery"
import { nativeAccountDeletionRecovery } from "../services/native-account-deletion"
import { Action, Copy, Loading, styles } from "../components/ui"

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
  if (error) return <View style={styles.center}><Copy>Unable to open saved account recovery information.</Copy><Action label="Try again" onPress={() => {setError(false);setAttempt(value => value+1)}} /></View>
  if (!controller) return <Loading label="Opening saved account information…" />
  return <RecoveryContext value={controller}><RecoveryReady>{children}</RecoveryReady></RecoveryContext>
}
function RecoveryReady({children}: PropsWithChildren) {
  const {controller,state} = useAccountDeletionRecovery()
  if (!state.ready) return <View style={{flex:1}}><Loading label="Checking saved account information…" />{state.error ? <View style={styles.content}><Copy>{state.error}</Copy><Action label="Try again" disabled={state.busy} onPress={() => void controller.refresh().catch(() => undefined)} /></View> : null}</View>
  return children
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
