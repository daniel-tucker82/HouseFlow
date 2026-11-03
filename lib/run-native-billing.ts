import { db } from "@/lib/db"
import { nativeBillingEnvironment } from "@/lib/billing-access"
import { revenueCatConfig } from "@/lib/revenuecat-native-billing"
import { processNativeBillingJobs } from "@/lib/native-billing-jobs"

export async function runNativeBilling() {
  if (process.env.NATIVE_BILLING_ENABLED !== "true") return { enabled: false, ok: true }
  try {
    const config = revenueCatConfig()
    if (!config || !nativeBillingEnvironment()) throw new Error("Invalid billing configuration")
    const result = await processNativeBillingJobs(db, config)
    if (result.ok) console.info("[native-billing] reconciliation complete", result)
    else console.warn("[native-billing] reconciliation needs retry", result)
    return { enabled: true, ...result }
  } catch {
    // Provider response bodies, credentials and customer attributes must never
    // appear in logs or public webhook responses.
    console.error("[native-billing] reconciliation failed")
    return { enabled: true, ok: false, error: "Billing verification needs retry" }
  }
}
