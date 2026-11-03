import { useAuth } from "@clerk/expo"
import { randomUUID } from "expo-crypto"
import * as Network from "expo-network"
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren } from "react"
import { AppState, View } from "react-native"
import { KioskController, type KioskIdentity } from "../services/kiosk-controller"
import { MobileApi } from "../services/api"
import { getDeviceId, getInstallationSecret, nativeKioskVault, openLocalStore } from "../storage/native-store"
import { resetNativeNotificationSession } from "../services/notification-native-session"
import { Action, Copy, Loading, styles } from "../components/ui"

const Context = createContext<KioskController | null>(null)
export function KioskProvider({ children }: PropsWithChildren) {
  const { userId, sessionId, isSignedIn, getToken } = useAuth({ treatPendingAsSignedOut: false })
  const identity = isSignedIn && userId && sessionId ? { accountId: userId, sessionId } : null
  const identityRef = useRef<KioskIdentity | null>(identity), tokenRef = useRef(getToken)
  useLayoutEffect(() => {
    identityRef.current = isSignedIn && userId && sessionId ? { accountId: userId, sessionId } : null
    tokenRef.current = getToken
  }, [isSignedIn, userId, sessionId, getToken])
  const [controller, setController] = useState<KioskController | null>(null), [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false, current: KioskController | undefined, subscription: (() => void) | undefined
    let network: ReturnType<typeof Network.addNetworkStateListener> | undefined, app: ReturnType<typeof AppState.addEventListener> | undefined
    void (async () => {
      const [store, deviceId] = await Promise.all([openLocalStore(), getDeviceId()])
      if (cancelled) return
      current = new KioskController(store.kiosk, nativeKioskVault, deviceId, expected => new MobileApi(
        process.env.EXPO_PUBLIC_API_URL ?? "https://www.cyntch.com", expected.accountId, deviceId, async () => {
          const matches = () => identityRef.current?.accountId === expected.accountId && identityRef.current.sessionId === expected.sessionId
          if (!matches()) return null
          const token = await tokenRef.current()
          return matches() ? token : null
        }, getInstallationSecret, expected.sessionId), randomUUID)
      subscription = current.subscribe(() => {
        if (current?.getSnapshot().record) void resetNativeNotificationSession(store.notificationSessions).catch(() => undefined)
      })
      current.setIdentity(identityRef.current); current.setActive(AppState.currentState === "active")
      const connected = (state: Network.NetworkState) => current?.setConnectivity(state.isConnected === true && state.isInternetReachable !== false)
      network = Network.addNetworkStateListener(connected)
      app = AppState.addEventListener("change", state => current?.setActive(state === "active"))
      setController(current); await current.start()
      void Network.getNetworkStateAsync().then(state => { if (!cancelled) connected(state) }).catch(() => undefined)
    })().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to read this device's kiosk lock.") })
    return () => { cancelled = true; subscription?.(); network?.remove(); app?.remove(); current?.stop() }
  }, [attempt])
  useEffect(() => { controller?.setIdentity(identityRef.current) }, [controller, userId, sessionId, isSignedIn])
  if (error) return <View style={styles.center}><Copy>{error}</Copy><Action label="Try again" onPress={() => { setError(null); setAttempt(value => value + 1) }} /></View>
  if (!controller) return <Loading label="Checking this device…" />
  return <Context value={controller}>{children}</Context>
}
export function useKiosk() {
  const controller = useContext(Context)
  if (!controller) throw new Error("Cyntch kiosk protection is unavailable")
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  return { controller, state }
}
