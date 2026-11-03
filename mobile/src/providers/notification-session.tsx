import { useAuth } from "@clerk/expo"
import * as Network from "expo-network"
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react"
import { AppState, View } from "react-native"
import { Action, Copy, Loading, styles } from "../components/ui"
import { NotificationSessionController, notificationRevocationTransport } from "../services/notification-session-controller"
import { resetNativeNotificationSession } from "../services/notification-native-session"
import { getDeviceId, getInstallationSecret, openLocalStore } from "../storage/native-store"

const NotificationSessionContext = createContext<{ signOut: () => Promise<void>; isSessionActive: (accountId: string, sessionId: string) => boolean } | null>(null)

/** Lives outside the signed-in runtime so offline sign-outs can finish later. */
export function NotificationSessionProvider({ children }: PropsWithChildren) {
  const { isLoaded, isSignedIn, userId, sessionId, signOut } = useAuth({ treatPendingAsSignedOut: false })
  const identity = isLoaded ? isSignedIn && userId && sessionId ? `${userId}:${sessionId}` : "signed-out" : null
  const [ready, setReady] = useState<string | null>(null)
  const readyIdentity = useRef<string | null>(null)
  const isSessionActive = useCallback((accountId: string, sessionId: string) => readyIdentity.current === `${accountId}:${sessionId}`, [])
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const revoker = useRef<NotificationSessionController | null>(null)
  const signOutRef = useRef(signOut)
  useEffect(() => { signOutRef.current = signOut }, [signOut])

  useEffect(() => {
    if (!isLoaded) return
    let cancelled = false
    let controller: NotificationSessionController | undefined
    let network: ReturnType<typeof Network.addNetworkStateListener> | undefined
    let app: ReturnType<typeof AppState.addEventListener> | undefined
    const work = queue.current.then(async () => {
      const [store, deviceId] = await Promise.all([openLocalStore(), getDeviceId()])
      if (cancelled) return
      controller = new NotificationSessionController(store.notificationSessions, notificationRevocationTransport(
        process.env.EXPO_PUBLIC_API_URL ?? "https://www.cyntch.com", deviceId, getInstallationSecret))
      revoker.current = controller
      const connected = (state: Network.NetworkState) => controller?.setConnectivity(state.isConnected === true && state.isInternetReachable !== false)
      const resume = () => { void resetNativeNotificationSession(store.notificationSessions).catch(() => { /* Persisted; retry on resume or before registration. */ }) }
      network = Network.addNetworkStateListener(state => { connected(state); if (state.isConnected) resume() })
      app = AppState.addEventListener("change", state => { controller?.setActive(state === "active"); if (state === "active") resume() })
      controller.setActive(AppState.currentState === "active")
      const result = await store.notificationSessions.activate(isSignedIn && userId && sessionId ? { accountId: userId, sessionId } : null)
      resume()
      // This is not on the sign-in critical path. Pending revocations survive a
      // failed connectivity inspection and retry on the next OS event.
      void Network.getNetworkStateAsync().then(state => { if (!cancelled) connected(state) }).catch(() => undefined)
      if (cancelled) return
      if (!result.allowed && sessionId) {
        // A crash may leave Clerk's cached session after our durable sign-out.
        // Finish that exact session, never a newer sign-in.
        await signOutRef.current({ sessionId })
        return
      }
      readyIdentity.current = identity
      setError(null); setReady(identity)
    })
    queue.current = work.catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to open your account on this device.") })
    return () => { cancelled = true; readyIdentity.current = null; network?.remove(); app?.remove(); controller?.stop(); if (revoker.current === controller) revoker.current = null }
  }, [isLoaded, isSignedIn, userId, sessionId, identity, attempt])

  async function leave() {
    if (!userId || !sessionId) return
    const session = { accountId: userId, sessionId }
    // Fence delayed native actions immediately, before React unmounts children
    // or the durable sign-out waits for another local transaction.
    readyIdentity.current = null
    setReady(null); setError(null)
    const work = queue.current.then(async () => {
      const store = await openLocalStore()
      await store.notificationSessions.close(session)
      void resetNativeNotificationSession(store.notificationSessions).catch(() => undefined)
      revoker.current?.wake()
      await signOutRef.current({ sessionId: session.sessionId })
    })
    queue.current = work.catch(cause => { setError(cause instanceof Error ? cause.message : "Sign-out needs another attempt.") })
    await queue.current
  }

  if (error) return <View style={styles.center} accessibilityRole="alert"><Copy>{error}</Copy><Action label="Try again" onPress={() => { setError(null); setAttempt(value => value + 1) }} /></View>
  if (!identity || ready !== identity) return <Loading label="Opening Cyntch…" />
  return <NotificationSessionContext value={{ signOut: leave, isSessionActive }}>{children}</NotificationSessionContext>
}

export function useNotificationSession() {
  const value = useContext(NotificationSessionContext)
  if (!value) throw new Error("Cyntch notification session is not available")
  return value
}
