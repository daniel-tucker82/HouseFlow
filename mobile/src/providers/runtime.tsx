import { useAuth } from "@clerk/expo"
import { randomUUID } from "expo-crypto"
import * as Network from "expo-network"
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake"
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren } from "react"
import { AppState, View } from "react-native"
import { MobileApi } from "../services/api"
import { BoardController } from "../services/board-controller"
import { getDeviceId, openLocalStore } from "../storage/native-store"
import type { LocalStore } from "../storage/local-store"
import { Action, Copy, Loading, styles } from "../components/ui"

interface Runtime { controller: BoardController; api: MobileApi; store: LocalStore; keepAwake: boolean; setKeepAwake: (enabled: boolean) => Promise<void> }
const RuntimeContext = createContext<Runtime | null>(null)

export function RuntimeProvider({ children, accountId }: PropsWithChildren<{ accountId: string }>) {
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
    let network: ReturnType<typeof Network.addNetworkStateListener> | undefined
    let app: ReturnType<typeof AppState.addEventListener> | undefined
    void (async () => {
      const [store, deviceId] = await Promise.all([openLocalStore(), getDeviceId()])
      const api = new MobileApi(process.env.EXPO_PUBLIC_API_URL ?? "https://www.cyntch.com", accountId, deviceId, () => tokenRef.current())
      const displaySetting = await store.setting<boolean>(accountId, "keep-awake")
      if (cancelled) return
      controller = new BoardController(store, accountId, deviceId, api, randomUUID)
      const connected = (state: Network.NetworkState) => controller?.setConnectivity(state.isConnected === true && state.isInternetReachable !== false)
      network = Network.addNetworkStateListener(connected)
      app = AppState.addEventListener("change", state => { setActive(state === "active"); controller?.setActive(state === "active") })
      setAwake(displaySetting === true)
      setRuntime({ controller, api, store })
      controller.setActive(AppState.currentState === "active")
      await controller.start()
      connected(await Network.getNetworkStateAsync())
    })().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to open your saved household") })
    return () => { cancelled = true; network?.remove(); app?.remove(); controller?.stop() }
  }, [accountId, attempt])

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
