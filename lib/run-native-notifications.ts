import { db } from "@/lib/db"
import { createExpoPushProvider } from "@/lib/expo-push-provider"
import { processNativeNotifications } from "@/lib/native-notification-worker"

/** Deployment gate stays off until native credentials and device handling are verified. */
export async function runNativeNotifications() {
  if (process.env.NATIVE_PUSH_ENABLED !== "true") return { enabled: false, expanded: 0, queued: 0, sendAttempts: 0, receipts: 0 }
  try {
    const result = await processNativeNotifications(db, createExpoPushProvider(process.env.EXPO_PUSH_ACCESS_TOKEN))
    console.info("[native-push] batch complete", result)
    return { enabled: true, ...result }
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    console.error("[native-push] batch needs retry", { code: typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : "WorkerFailed" })
    throw new Error("Native notifications need retry")
  }
}
