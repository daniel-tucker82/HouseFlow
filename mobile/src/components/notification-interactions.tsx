import { useEffect } from "react"
import { Alert, AppState } from "react-native"
import { router, useRootNavigationState } from "expo-router"
import { useRuntime } from "../providers/runtime"
import { NotificationNavigationController } from "../services/notification-navigation"
import { bindNotificationEvents } from "../services/notification-events"

export function NotificationInteractions({ accountId, sessionId }: { accountId: string; sessionId: string }) {
  const { controller, runs, notifications, history, store } = useRuntime()
  const navigation = useRootNavigationState()
  useEffect(() => {
    if (!navigation?.key) return
    const session = { accountId, sessionId }
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const taps = new NotificationNavigationController(store.notificationInbox, session, controller, runs, {
      ready: () => true,
      allowed: payload => payload.accountId === accountId && payload.sessionId === sessionId,
      navigate: route => router.navigate(route),
      failed: (message, retry, dismiss) => Alert.alert("Notification unavailable", message, [
        { text: "Close", style: "cancel", onPress: dismiss }, { text: "Try again", onPress: retry },
      ], { cancelable: true, onDismiss: dismiss }),
    })
    const events = bindNotificationEvents({
      session, canPresent: payload => notifications.canPresent(payload),
      canPlaySound: () => notifications.getSnapshot().permission === "granted",
      capture: payload => taps.capture(payload),
      received: () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { void controller.refresh(); void history.refresh() }, 250) },
      failed: () => Alert.alert("Notification unavailable", "The notification could not be saved on this device. Please try opening it again."),
    })
    const board = controller.subscribe(() => taps.wake())
    const app = AppState.addEventListener("change", state => { taps.setActive(state === "active"); if (state === "active") events.resume() })
    taps.setActive(AppState.currentState === "active")
    taps.wake()
    return () => { clearTimeout(refreshTimer); board(); app.remove(); events.stop(); taps.stop() }
  }, [accountId, sessionId, controller, runs, notifications, history, store, navigation?.key])
  return null
}
