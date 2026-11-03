import { after } from "next/server"
import { db } from "@/lib/db"
import { acceptNativeBillingWebhook, nativeBillingWebhookConfig, readNativeBillingWebhook, NativeBillingWebhookError } from "@/lib/native-billing-webhook"
import { runNativeBilling } from "@/lib/run-native-billing"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

export async function POST(request: Request) {
  try {
    const config = nativeBillingWebhookConfig()
    const event = await readNativeBillingWebhook(request, config)
    const result = await acceptNativeBillingWebhook(db, config, event)
    // A best-effort prompt drain. The committed job and cron path provide the
    // durable retry if the process exits before/inside this callback.
    if (result.queued || result.duplicate && result.outcome === "queued") after(async () => { await runNativeBilling() })
    return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    const status = error instanceof NativeBillingWebhookError ? error.status : 503
    return Response.json({ error: status === 503 ? "Webhook unavailable; retry required" : "Invalid webhook" },
      { status, headers: { "Cache-Control": "no-store" } })
  }
}
