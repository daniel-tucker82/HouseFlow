import { useAuth } from "@clerk/expo"
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto"
import * as Network from "expo-network"
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake"
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren } from "react"
import { AppState, View } from "react-native"
import { MobileApi } from "../services/api"
import { BoardController } from "../services/board-controller"
import { PlannerController } from "../services/planner-controller"
import { RunsController } from "../services/runs-controller"
import { NotificationController } from "../services/notification-controller"
import { NotificationHistoryController } from "../services/notification-history-controller"
import { createNotificationDevice } from "../services/notification-device"
import { BillingController } from "../services/billing-controller"
import { nativeBillingSdk } from "../services/billing-native"
import { useKiosk } from "./kiosk"
import { useNotificationSession } from "./notification-session"
import { getDeviceId, getInstallationSecret, openLocalStore } from "../storage/native-store"
import type { LocalStore } from "../storage/local-store"
import { Action, Copy, Loading, styles } from "../components/ui"

interface Runtime { controller: BoardController; planner: PlannerController; runs: RunsController; notifications: NotificationController; history: NotificationHistoryController; billing: BillingController; api: MobileApi; store: LocalStore; keepAwake: boolean; syncPaused: boolean; setKeepAwake: (enabled: boolean) => Promise<void> }
const RuntimeContext = createContext<Runtime | null>(null)

export function RuntimeProvider({ children, accountId, sessionId, restricted = false, canSync = true }: PropsWithChildren<{ accountId: string; sessionId: string; restricted?: boolean; canSync?: boolean }>) {
  const { getToken, userId: currentAccountId, sessionId: currentSessionId, isSignedIn } = useAuth({ treatPendingAsSignedOut: false })
  const { controller: kiosk } = useKiosk()
  const { isSessionActive } = useNotificationSession()
  const tokenRef = useRef(getToken)
  const identityRef = useRef({ accountId: currentAccountId, sessionId: currentSessionId, signedIn: isSignedIn })
  useLayoutEffect(() => {
    tokenRef.current = getToken
    identityRef.current = { accountId: currentAccountId, sessionId: currentSessionId, signedIn: isSignedIn }
  }, [getToken, currentAccountId, currentSessionId, isSignedIn])
  const [runtime, setRuntime] = useState<Omit<Runtime, "keepAwake" | "syncPaused" | "setKeepAwake"> | null>(null)
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
    let billing: BillingController | undefined
    let history: NotificationHistoryController | undefined
    let notificationSubscription: (() => void) | undefined
    let boardSubscription: (() => void) | undefined
    let network: ReturnType<typeof Network.addNetworkStateListener> | undefined
    let app: ReturnType<typeof AppState.addEventListener> | undefined
    void (async () => {
      const [store, deviceId] = await Promise.all([openLocalStore(), getDeviceId()])
      const matchesIdentity = () => !cancelled && isSessionActive(accountId,sessionId) && identityRef.current.signedIn === true && identityRef.current.accountId === accountId && identityRef.current.sessionId === sessionId
      const api = new MobileApi(process.env.EXPO_PUBLIC_API_URL ?? "https://www.cyntch.com", accountId, deviceId, async () => {
        if (!matchesIdentity()) return null
        const token = await tokenRef.current()
        return matchesIdentity() ? token : null
      }, getInstallationSecret, sessionId)
      const displaySetting = await store.setting<boolean>(accountId, "keep-awake")
      if (cancelled) return
      controller = new BoardController(store, accountId, deviceId, api, randomUUID)
      planner = new PlannerController(store.planner, accountId, deviceId, api, randomUUID, async () => { await controller?.refresh() })
      runs = new RunsController(store, accountId, api, controller, householdId => {
        const protection = kiosk.getSnapshot()
        return matchesIdentity() && !restricted && canSync && protection.ready && !protection.changing && !protection.record
          && controller?.getSelectedHouseholdId() === householdId
      })
      notifications = new NotificationController(store.notifications.forSession(accountId, sessionId), accountId, api, createNotificationDevice(store.notificationSessions), randomUUID,
        Date.now, selection => digestStringAsync(CryptoDigestAlgorithm.SHA256, selection))
      billing = new BillingController(store.billing, { accountId, sessionId, deviceId }, api, nativeBillingSdk, householdId => {
        const protection = kiosk.getSnapshot()
        return matchesIdentity() && !restricted && canSync && protection.ready && !protection.changing && !protection.record && controller?.getSelectedHouseholdId() === householdId
      }, randomUUID)
      history = new NotificationHistoryController(store.notificationHistory, { accountId, sessionId, deviceId }, api, householdId => {
        const protection = kiosk.getSnapshot()
        return matchesIdentity() && !restricted && canSync && protection.ready && !protection.changing && !protection.record && controller?.getSelectedHouseholdId() === householdId
      }, randomUUID, async () => {
        await controller?.refresh()
        const board = controller?.getSnapshot()
        if (!board?.online || board.error || board.refreshing) throw new Error("Connect to refresh this household before opening the notification.")
      }, Date.now, householdId => {
        const protection = kiosk.getSnapshot()
        return matchesIdentity() && !restricted && canSync && protection.ready && !protection.changing && !protection.record
          && controller?.getSnapshot().households.some(household => household.id === householdId) === true
      })
      notificationSubscription = notifications.subscribe(() => {
        const state = notifications?.getSnapshot()
        if (state) history?.observe(state.household, state.preferences, state.pending.some(row => row.scope === "device" || row.scope === state.household?.id))
      })
      boardSubscription = controller.subscribe(() => { if (controller && !restricted) { void planner?.selectHousehold(controller.getSnapshot().board?.household ?? null); runs?.observe(controller.getSnapshot()); billing?.selectHousehold(controller.getSnapshot().board?.household ?? null); if (canSync) notifications?.observe(controller.getSnapshot()) } })
      const connected = (state: Network.NetworkState) => {
        const online = canSync && state.isConnected === true && state.isInternetReachable !== false
        controller?.setConnectivity(online); planner?.setConnectivity(!restricted && online); notifications?.setConnectivity(!restricted && online); billing?.setConnectivity(!restricted && online); history?.setConnectivity(!restricted && online)
      }
      network = Network.addNetworkStateListener(connected)
      app = AppState.addEventListener("change", state => { setActive(state === "active"); controller?.setActive(state === "active"); planner?.setActive(!restricted && state === "active"); runs?.setActive(!restricted && state === "active"); notifications?.setActive(!restricted && canSync && state === "active"); billing?.setActive(!restricted && canSync && state === "active"); history?.setActive(!restricted && canSync && state === "active") })
      setAwake(displaySetting === true)
      setRuntime({ controller, planner, runs, notifications, billing, history, api, store })
      controller.setActive(AppState.currentState === "active")
      planner.setActive(!restricted && AppState.currentState === "active")
      runs.setActive(!restricted && AppState.currentState === "active")
      notifications.setActive(!restricted && canSync && AppState.currentState === "active")
      billing.setActive(!restricted && canSync && AppState.currentState === "active")
      history.setActive(!restricted && canSync && AppState.currentState === "active")
      await controller.start()
      if (!restricted && canSync) await notifications.start()
      connected(await Network.getNetworkStateAsync())
    })().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to open your saved household") })
    return () => { cancelled = true; network?.remove(); app?.remove(); boardSubscription?.(); notificationSubscription?.(); controller?.stop(); planner?.stop(); runs?.stop(); notifications?.stop(); billing?.stop(); history?.stop() }
  }, [accountId, sessionId, attempt, restricted, canSync, kiosk, isSessionActive])

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
  return <RuntimeContext value={{ ...runtime, keepAwake, syncPaused: !canSync, setKeepAwake: async enabled => {
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
export function useBilling() {
  const { billing } = useRuntime()
  return useSyncExternalStore(billing.subscribe, billing.getSnapshot, billing.getSnapshot)
}
export function useNotificationHistory() {
  const { history } = useRuntime()
  return useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot)
}
