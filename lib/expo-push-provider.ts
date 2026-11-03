import type { NativePushMessage } from "@/lib/native-notification-outbox"

export type ExpoPushResult = { status: "ok"; id?: string } | { status: "error"; code: string }
export interface NativePushProvider {
  send(messages: NativePushMessage[]): Promise<ExpoPushResult[]>
  receipts(ids: string[]): Promise<Record<string, ExpoPushResult>>
}
export class PushProviderError extends Error {
  constructor(public code: string, public retryable: boolean) { super(code) }
}
const knownCodes = new Set(["DeviceNotRegistered", "MessageTooBig", "MessageRateExceeded", "MismatchSenderId", "InvalidCredentials"])
function result(value: unknown, ticket: boolean): ExpoPushResult {
  if (!value || typeof value !== "object") throw new PushProviderError("InvalidResponse", true)
  const row = value as { status?: unknown; id?: unknown; details?: { error?: unknown } }
  if (row.status === "ok") {
    if (ticket && (typeof row.id !== "string" || row.id.length < 1 || row.id.length > 256)) throw new PushProviderError("InvalidTicket", true)
    return { status: "ok", ...(ticket ? { id: row.id as string } : {}) }
  }
  if (row.status !== "error") throw new PushProviderError("InvalidResponse", true)
  return { status: "error", code: typeof row.details?.error === "string" && knownCodes.has(row.details.error) ? row.details.error : "ProviderError" }
}

/** Error messages/bodies can contain tokens. Return only controlled error codes. */
export function createExpoPushProvider(accessToken?: string, request: typeof fetch = fetch): NativePushProvider {
  async function post(path: "send" | "getReceipts", body: unknown) {
    let response: Response
    try {
      response = await request(`https://exp.host/--/api/v2/push/${path}`, { method: "POST",
        headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8_000) })
    } catch { throw new PushProviderError("NetworkUnavailable", true) }
    if (!response.ok) throw new PushProviderError(response.status === 429 ? "RateLimited" : response.status >= 500 ? "ProviderUnavailable"
      : response.status === 401 || response.status === 403 ? "InvalidCredentials" : "RequestRejected", response.status === 429 || response.status >= 500 || response.status === 401 || response.status === 403)
    try {
      const parsed = await response.json() as { data?: unknown; errors?: unknown[] }
      if (parsed.errors?.length || !parsed.data || typeof parsed.data !== "object") throw new Error()
      return parsed.data
    } catch { throw new PushProviderError("InvalidResponse", true) }
  }
  return {
    async send(messages) {
      if (!messages.length) return []
      if (messages.length > 100 || messages.some(message => Buffer.byteLength(JSON.stringify(message), "utf8") > 4096)) throw new PushProviderError("MessageTooBig", false)
      const data = await post("send", messages)
      if (!Array.isArray(data) || data.length !== messages.length) throw new PushProviderError("InvalidResponse", true)
      // Preserve valid tickets even if a different item has a malformed reply.
      return data.map(row => {
        try { return result(row, true) }
        catch (error) { return { status: "error" as const, code: error instanceof PushProviderError ? error.code : "InvalidResponse" } }
      })
    },
    async receipts(ids) {
      if (!ids.length) return {}
      if (ids.length > 1000) throw new PushProviderError("TooManyReceipts", false)
      const data = await post("getReceipts", { ids })
      if (Array.isArray(data)) throw new PushProviderError("InvalidResponse", true)
      return Object.fromEntries(ids.filter(id => Object.hasOwn(data, id)).flatMap(id => {
        try { return [[id, result((data as Record<string, unknown>)[id], false)]] }
        catch { return [] } // A malformed receipt is unknown, not a reason to resend.
      }))
    },
  }
}
