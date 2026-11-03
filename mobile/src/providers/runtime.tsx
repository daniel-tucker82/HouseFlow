import { useAuth } from "@clerk/expo"
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto"
import * as Network from "expo-network"
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake"
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren } from "react"
import { AppState, View } from "react-native"
import { MobileApi } from "../services/api"
import { BoardController } from "../services/board-controller"
import { PlannerController } from "../services/planner-controller"
import { RunsController } from "../services/runs-controller"
import { NotificationController } from "../services/notification-controller"
import { createNotificationDevice } from "../services/notification-device"
import { getDeviceId, getInstallationSecret, openLocalStore } from "../storage/native-store"
import type { LocalStore } from "../storage/local-store"
import { Action, Copy, Loading, styles } from "../components/ui"

interface Runtime { controller: BoardController; planner: PlannerController; runs: RunsController; notifications: NotificationController; api: MobileApi; store: LocalStore; keepAwake: boolean; setKeepAwake: (enabled: boolean) => Promise<void> }
const RuntimeContext = createContext<Runtime | null>(null)

export function RuntimeProvider({ children, accountId, sessionId }: PropsWithChildren<{ accountId: string; sessionId: string }>) {
  const { getToken } = useAuth()
  const tokenRef = useRef(getToken)
  useEffect(() => { tokenRef.current = getToken }, [getToken])
  const [runtime, setRuntime] = useState<Omit<Runtime, "keepAwake" | "setKeepAwake"> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [keepAwake, setAwake] = useState(false)
  const [active, setActive] = useState(AppState.currentState === "active")

  useEffect(() => {
    let cancelled = false
    let controller: BoardController | undefined
    let planner: PlannerController | undefined
    let runs: RunsController | undefined
    let notifications: NotificationController | undefined
    let boardSubscription: (() => void) | undefined
    let network: ReturnType<typeof Network.addNetworkStateListener> | undefined
    let app: ReturnType<typeof AppState.addEventListener> | undefined
    void (async () => {
      const [store, deviceId] = await Promise.all([openLocalStore(), getDeviceId()])
      const api = new MobileApi(process.env.EXPO_PUBLIC_API_URL ?? "https://www.cyntch.com", accountId, deviceId, () => tokenRef.current(), getInstallationSecret, sessionId)
      const displaySetting = await store.setting<boolean>(accountId, "keep-awake")
      if (cancelled) return
      controller = new BoardController(store, accountId, deviceId, api, randomUUID)
      planner = new PlannerController(store.planner, accountId, deviceId, api, randomUUID, async () => { await controller?.refresh() })
      runs = new RunsController(store, accountId, api, controller)
      notifications = new NotificationController(store.notifications.forSession(accountId, sessionId), accountId, api, createNotificationDevice(store.notificationSessions), randomUUID,
        Date.now, selection => digestStringAsync(CryptoDigestAlgorithm.SHA256, selection))
      boardSubscription = controller.subscribe(() => { if (controller) { void planner?.selectHousehold(controller.getSnapshot().board?.household ?? null); runs?.observe(controller.getSnapshot()); notifications?.observe(controller.getSnapshot()) } })
      const connected = (state: Network.NetworkState) => {
        const online = state.isConnected === true && state.isInternetReachable !== false
        controller?.setConnectivity(online); planner?.setConnectivity(online); notifications?.setConnectivity(online)
      }
      network = Network.addNetworkStateListener(connected)
      app = AppState.addEventListener("change", state => { setActive(state === "active"); controller?.setActive(state === "active"); planner?.setActive(state === "active"); runs?.setActive(state === "active"); notifications?.setActive(state === "active") })
      setAwake(displaySetting === true)
      setRuntime({ controller, planner, runs, notifications, api, store })
      controller.setActive(AppState.currentState === "active")
      planner.setActive(AppState.currentState === "active")
      runs.setActive(AppState.currentState === "active")
      notifications.setActive(AppState.currentState === "active")
      await controller.start()
      await notifications.start()
      connected(await Network.getNetworkStateAsync())
    })().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to open your saved household") })
    return () => { cancelled = true; network?.remove(); app?.remove(); boardSubscription?.(); controller?.stop(); planner?.stop(); runs?.stop(); notifications?.stop() }
  }, [accountId, sessionId, attempt])

  useEffect(() => {
    let cancelled = false
    const tag = `cyntch-display-${accountId}`
    if (keepAwake && active) void activateKeepAwakeAsync(tag).then(() => {
      if (cancelled) return deactivateKeepAwake(tag)
    }).catch(() => setError("This device could not keep the display awake. Check its display settings."))
    return () => { cancelled = true; void deactivateKeepAwake(tag).catch(() => undefined) }
  }, [keepAwake, active, accountId])

  if (error && !runtime) return <View style={styles.center}><Copy>{error}</Copy><Action label="Try again" onPress={() => { setError(null); setAttempt(value => value + 1) }} /></View>
  if (!runtime) return <Loading />
  return <RuntimeContext value={{ ...runtime, keepAwake, setKeepAwake: async enabled => {
    await runtime.store.saveSetting(accountId, "keep-awake", enabled)
    setAwake(enabled)
  } }}><View style={{ flex: 1 }}>{error ? <View accessibilityRole="alert" style={{ padding: 16 }}><Copy>{error}</Copy></View> : null}{children}</View></RuntimeContext>
}

export function useRuntime() {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error("Cyntch runtime is not available")
  return runtime
}
export function useBoard() {
  const { controller } = useRuntime()
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}
export function usePlanner() {
  const { planner } = useRuntime()
  return useSyncExternalStore(planner.subscribe, planner.getSnapshot, planner.getSnapshot)
}
export function useRuns() {
  const { runs } = useRuntime()
  return useSyncExternalStore(runs.subscribe, runs.getSnapshot, runs.getSnapshot)
}
export function useNotifications() {
  const { notifications } = useRuntime()
  return useSyncExternalStore(notifications.subscribe, notifications.getSnapshot, notifications.getSnapshot)
}
