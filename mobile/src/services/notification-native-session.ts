import * as Notifications from "expo-notifications"
import type { NotificationSessionStore } from "../storage/notification-session-store"

// Token creation and destruction share a queue. A delayed sign-out cleanup must
// never unregister a token that a later sign-in has just acquired.
let tail: Promise<unknown> = Promise.resolve()
let generation = 0
export const nativeNotificationGeneration = () => generation
const resets = new WeakMap<NotificationSessionStore, Promise<void>>()
export function withNativeNotificationSession<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work)
  tail = result.catch(() => undefined)
  return result
}

export function resetNativeNotificationSession(store: NotificationSessionStore) {
  const pending = resets.get(store)
  if (pending) return pending
  const work = withNativeNotificationSession(async () => {
    for (;;) {
      const version = await store.cleanupVersion()
      if (version === null) return
      Notifications.clearLastNotificationResponse()
      // These operations are local except provider token invalidation. Task saves
      // and sign-in screens do not wait for them; registration uses the same queue.
      const results = await Promise.allSettled([
        Notifications.dismissAllNotificationsAsync(),
        Notifications.cancelAllScheduledNotificationsAsync(),
        Notifications.unregisterForNotificationsAsync(),
      ])
      generation++
      if (results.some(result => result.status === "rejected")) throw new Error("Notification sign-out is waiting to finish on this device.")
      await store.completeCleanup(version)
    }
  }).finally(() => resets.delete(store))
  resets.set(store, work)
  return work
}

/** Keep notification controls responsive even if a native/provider call stalls.
 * The underlying operation retains its place in the queue; timing out must not
 * let an old unregister overtake a new token. Restart resumes the durable work.
 */
export async function waitForNativeNotification<T>(request: Promise<T>, timeoutMs = 8_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([request, new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Notification registration is taking longer than expected. You can keep using Cyntch and try again later.")), timeoutMs)
  })]) } finally { clearTimeout(timeout) }
}
