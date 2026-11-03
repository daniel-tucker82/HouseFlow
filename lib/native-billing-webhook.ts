import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { Pool } from "pg"
import { nativeBillingEnvironment } from "@/lib/billing-access"
import { enqueueNativeBillingAccount } from "@/lib/native-billing-jobs"

export class NativeBillingWebhookError extends Error {
  constructor(public code: "configuration" | "unauthorized" | "too_large" | "invalid_event" | "event_conflict", public status: number) {
    super(code)
    this.name = "NativeBillingWebhookError"
  }
}
export type NativeBillingWebhookConfig = {
  projectId: string; environment: "production" | "sandbox"; appIds: string[]; authorization: string; signingSecret: string
}
const relevant = new Set(["INITIAL_PURCHASE", "RENEWAL", "CANCELLATION", "UNCANCELLATION", "BILLING_ISSUE", "PRODUCT_CHANGE",
  "EXPIRATION", "SUBSCRIPTION_PAUSED", "SUBSCRIPTION_EXTENDED", "REFUND_REVERSED", "TRANSFER", "TEMPORARY_ENTITLEMENT_GRANT",
  "SUBSCRIBER_ALIAS", "PRICE_INCREASE_CONSENT_REQUIRED", "PRICE_INCREASE_CONSENT_APPROVED"])
const sparse = new Set(["TRANSFER", "TEMPORARY_ENTITLEMENT_GRANT", "TEST"])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value)
}
export function nativeBillingWebhookConfig(env: NodeJS.ProcessEnv = process.env): NativeBillingWebhookConfig {
  const environment = nativeBillingEnvironment(env), appIds = (env.REVENUECAT_APP_IDS ?? "").split(",").map(value => value.trim())
  if (!environment || !validText(env.REVENUECAT_PROJECT_ID, 255) || appIds.length !== 2 || new Set(appIds).size !== 2 || appIds.some(id => !validText(id, 255)) ||
    !validText(env.REVENUECAT_WEBHOOK_AUTHORIZATION, 1000) || env.REVENUECAT_WEBHOOK_AUTHORIZATION.length < 32 ||
    !validText(env.REVENUECAT_WEBHOOK_SIGNING_SECRET, 1000) || env.REVENUECAT_WEBHOOK_SIGNING_SECRET.length < 32) throw new NativeBillingWebhookError("configuration", 503)
  return { projectId: env.REVENUECAT_PROJECT_ID, environment, appIds,
    authorization: env.REVENUECAT_WEBHOOK_AUTHORIZATION, signingSecret: env.REVENUECAT_WEBHOOK_SIGNING_SECRET }
}
function equal(a: string, b: string) {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Read a bounded raw body, then authenticate those exact bytes. Delivery
 * timestamps (not event age) expire after five minutes; provider retries sign
 * anew, so old lifecycle events can still be delivered safely. */
export async function readNativeBillingWebhook(request: Request, config: NativeBillingWebhookConfig, now = Date.now()) {
  if (!equal(request.headers.get("authorization") ?? "", config.authorization)) throw new NativeBillingWebhookError("unauthorized", 401)
  const header = request.headers.get("x-revenuecat-webhook-signature") ?? ""
  const parts = header.split(",").map(value => value.trim())
  const time = parts.find(value => /^t=[0-9]{1,12}$/.test(value))?.slice(2), signature = parts.find(value => /^v1=[0-9a-f]{64}$/i.test(value))?.slice(3)
  if (parts.length !== 2 || !time || !signature || Math.abs(now / 1000 - Number(time)) > 300) throw new NativeBillingWebhookError("unauthorized", 401)
  const reader = request.body?.getReader(), chunks: Uint8Array[] = []
  let size = 0
  if (!reader) throw new NativeBillingWebhookError("invalid_event", 400)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 262_144) { await reader.cancel(); throw new NativeBillingWebhookError("too_large", 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = Buffer.concat(chunks)
  const expected = createHmac("sha256", config.signingSecret).update(`${time}.`).update(bytes).digest("hex")
  if (!equal(signature.toLowerCase(), expected)) throw new NativeBillingWebhookError("unauthorized", 401)
  let body: unknown
  try { body = JSON.parse(bytes.toString("utf8")) } catch { throw new NativeBillingWebhookError("invalid_event", 400) }
  return parseNativeBillingWebhook(body)
}

export type NativeBillingEvent = {
  id: string; type: string; at: number; environment: "production" | "sandbox" | null; appId: string | null; customerIds: string[]; fingerprint: string
}
export function parseNativeBillingWebhook(body: unknown): NativeBillingEvent {
  const raw = body as { api_version?: unknown; event?: Record<string, unknown> } | null
  const event = raw?.event
  if (!raw || raw.api_version !== "1.0" || !event || Array.isArray(event) || typeof event !== "object" ||
    !validText(event.id, 255) || !validText(event.type, 80) || !/^[A-Z][A-Z0-9_]*$/.test(event.type) ||
    typeof event.event_timestamp_ms !== "number" || !Number.isSafeInteger(event.event_timestamp_ms) || event.event_timestamp_ms <= 0 || event.event_timestamp_ms > 8_640_000_000_000_000 ||
    (event.environment !== undefined && !["PRODUCTION", "SANDBOX"].includes(String(event.environment))) ||
    (event.app_id !== undefined && !validText(event.app_id, 255))) throw new NativeBillingWebhookError("invalid_event", 400)
  if (relevant.has(event.type) && !sparse.has(event.type) && (!event.environment || !event.app_id || !validText(event.app_user_id, 1500))) throw new NativeBillingWebhookError("invalid_event", 400)
  const customers = new Set<string>()
  for (const field of ["app_user_id", "original_app_user_id"]) {
    const value = event[field]
    if (value !== undefined && !validText(value, 1500)) throw new NativeBillingWebhookError("invalid_event", 400)
    if (typeof value === "string") customers.add(value)
  }
  for (const field of ["aliases", "transferred_from", "transferred_to"]) {
    const value = event[field]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.length > 100 || value.some(id => !validText(id, 1500))) throw new NativeBillingWebhookError("invalid_event", 400)
    for (const id of value) customers.add(id)
  }
  if (event.type === "TRANSFER" && (!Array.isArray(event.transferred_from) || !event.transferred_from.length || !Array.isArray(event.transferred_to) || !event.transferred_to.length)) throw new NativeBillingWebhookError("invalid_event", 400)
  if (relevant.has(event.type) && !customers.size) throw new NativeBillingWebhookError("invalid_event", 400)
  const normalized = { id: event.id, type: event.type, at: event.event_timestamp_ms,
    environment: event.environment === "PRODUCTION" ? "production" as const : event.environment === "SANDBOX" ? "sandbox" as const : null,
    appId: typeof event.app_id === "string" ? event.app_id : null, customerIds: [...customers].sort() }
  return { ...normalized, fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") }
}

/** A receipt and all affected jobs commit together before HTTP 200. Payload
 * expiry/payment claims are never copied into entitlements. We retain only the
 * event envelope, a fingerprint and known opaque identities, not customer PII. */
export async function acceptNativeBillingWebhook(pool: Pool, config: NativeBillingWebhookConfig, event: NativeBillingEvent) {
  const client = await pool.connect()
  try {
    await client.query("begin")
    await client.query("set local statement_timeout='5s'")
    let outcome = event.type === "TEST" ? "test" : !relevant.has(event.type) ? "ignored_type"
      : event.environment && event.environment !== config.environment ? "ignored_environment"
        : event.appId && !config.appIds.includes(event.appId) ? "ignored_app" : "queued"
    const ids = event.customerIds.filter(id => uuid.test(id))
    const accounts = outcome === "queued" ? (await client.query<{ id: string }>(`select id from native_billing_accounts
      where project_id=$1 and environment=$2 and household_id is not null and id=any($3::uuid[]) order by id`, [config.projectId,config.environment,ids])).rows : []
    if (outcome === "queued" && !accounts.length) outcome = "unknown_customer"
    const receipt = await client.query(`insert into native_billing_webhook_receipts(project_id,event_id,event_type,event_at,environment,app_id,fingerprint,outcome,account_ids)
      values($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9::uuid[]) on conflict(project_id,event_id) do nothing returning event_id`,
    [config.projectId,event.id,event.type,new Date(event.at).toISOString(),event.environment,event.appId,event.fingerprint,outcome,accounts.map(row => row.id)])
    if (!receipt.rowCount) {
      const existing = (await client.query<{ fingerprint: string; outcome: string }>("select fingerprint,outcome from native_billing_webhook_receipts where project_id=$1 and event_id=$2", [config.projectId,event.id])).rows[0]
      if (existing.fingerprint !== event.fingerprint) throw new NativeBillingWebhookError("event_conflict", 409)
      await client.query("commit")
      return { duplicate: true, queued: 0, outcome: existing.outcome }
    }
    for (const account of accounts) await enqueueNativeBillingAccount(client, account.id)
    await client.query("commit")
    return { duplicate: false, queued: accounts.length, outcome }
  } catch (error) { await client.query("rollback"); throw error }
  finally { client.release() }
}
