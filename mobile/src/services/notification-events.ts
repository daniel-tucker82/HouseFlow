import * as Notifications from "expo-notifications"
import { parseNativeNotificationPayload, type NativeNotificationPayload } from "../../../shared/mobile/notification-payload"
import type { NotificationSession } from "../storage/notification-session-store"

interface Binding {
  session: NotificationSession
  canPresent(payload: NativeNotificationPayload): boolean
  canPlaySound(): boolean
  capture(payload: NativeNotificationPayload): Promise<boolean>
  received(payload: NativeNotificationPayload): void
  failed(): void
}
let binding: Binding | null = null
const presented = new Set<string>()
function matching(data: unknown, target: Binding | null) {
  const payload = parseNativeNotificationPayload(data)
  return target && payload?.accountId === target.session.accountId && payload.sessionId === target.session.sessionId ? payload : null
}

// Install before authentication/storage starts. SDK 58 otherwise presents by
// default, including when an asynchronous handler misses its three-second limit.
Notifications.setNotificationHandler({ handleNotification: async notification => {
  const current = binding, payload = matching(notification.request.content.data, current)
  let show = false, sound = false
  try {
    show = Boolean(current && payload && !presented.has(payload.deliveryId) && current.canPresent(payload))
    sound = show && current!.canPlaySound()
    if (show && payload) {
      if (presented.size >= 200) presented.delete(presented.values().next().value!)
      presented.add(payload.deliveryId)
    }
  } catch { show = false; sound = false }
  return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: sound, shouldSetBadge: false }
} })

export function bindNotificationEvents(next: Binding) {
  binding = next
  function clearIfCurrent(response: Notifications.NotificationResponse) {
    const last = Notifications.getLastNotificationResponse()
    if (last?.notification.request.identifier === response.notification.request.identifier && last.actionIdentifier === response.actionIdentifier) Notifications.clearLastNotificationResponse()
  }
  async function respond(response: Notifications.NotificationResponse) {
    if (binding !== next) return
    const payload = matching(response.notification.request.content.data, next)
    if (!payload || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) { clearIfCurrent(response); return }
    try {
      await next.capture(payload)
      // Clear only after SQLite commits. An interrupted write is retried from
      // the OS response on resume; a later response must not be cleared here.
      clearIfCurrent(response)
      void Notifications.dismissNotificationAsync(response.notification.request.identifier).catch(() => {})
    } catch { if (binding === next) next.failed() }
  }
  const responses = Notifications.addNotificationResponseReceivedListener(response => { void respond(response) })
  const received = Notifications.addNotificationReceivedListener(notification => {
    if (binding !== next) return
    const payload = matching(notification.request.content.data, next)
    if (payload) next.received(payload)
  })
  const resume = () => { const last = Notifications.getLastNotificationResponse(); if (last) void respond(last) }
  resume()
  return { resume, stop: () => { if (binding === next) binding = null; responses.remove(); received.remove() } }
}
