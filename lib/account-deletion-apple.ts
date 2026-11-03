import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes, sign } from "node:crypto"
import { AccountDeletionProcessingError } from "@/lib/account-deletion-processing"

type Json = Record<string, unknown>
type SealedToken = { keyId: string; iv: string; tag: string; ciphertext: string }
export type AppleRevocationRecord = { externalId: string; status: "pending" | "revoked" | "manual"; clientId?: string; credential?: SealedToken }
export type AppleRevocationConfig = {
  clients: { clientId: string; teamId: string; keyId: string; privateKey: string }[]
  tokenKeys: { current: string; keys: Record<string, string> }
}
export type AppleExternalAccount = { id: string; providerUserId: string }
type Context = {
  requestId: string; accountId: string; instanceId: string
  records: AppleRevocationRecord[]; accounts: AppleExternalAccount[]; userExists: boolean
  save: (records: AppleRevocationRecord[]) => Promise<void>
  tokens: () => Promise<Json[] | null>
  signal: () => Promise<AbortSignal>
  fetcher: typeof fetch; config?: AppleRevocationConfig
}
const failed = () => new AccountDeletionProcessingError("identity_cleanup_failed")
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failed()
  return value as Json
}
function text(value: unknown, maximum = 255): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u0020\u007f]/.test(value)
}
function configured(): AppleRevocationConfig {
  return { clients: JSON.parse(process.env.APPLE_SIGN_IN_CLIENTS ?? "null"), tokenKeys: JSON.parse(process.env.ACCOUNT_DELETION_TOKEN_KEYS ?? "null") }
}
function decode(value: string, maximum: number) {
  if (!text(value, maximum * 2) || !/^[A-Za-z0-9_-]+$/.test(value)) throw failed()
  const result = Buffer.from(value, "base64url")
  if (!result.length || result.length > maximum || result.toString("base64url") !== value) throw failed()
  return result
}
function encryptionKey(config: AppleRevocationConfig, id: string) {
  if (!text(id, 80) || !config.tokenKeys?.keys || !Object.hasOwn(config.tokenKeys.keys, id)) throw failed()
  const encoded = config.tokenKeys.keys[id]
  if (!text(encoded, 100)) throw failed()
  const key = Buffer.from(encoded, "base64")
  if (key.length !== 32 || key.toString("base64") !== encoded) throw failed()
  return key
}
function client(config: AppleRevocationConfig, clientId: string) {
  if (!Array.isArray(config.clients) || !config.clients.length || config.clients.length > 20 || config.clients.filter(item => item.clientId === clientId).length !== 1) throw failed()
  const selected = config.clients.find(item => item.clientId === clientId)!
  if (!text(selected.clientId) || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(selected.clientId) ||
    typeof selected.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(selected.teamId) ||
    typeof selected.keyId !== "string" || !/^[A-Z0-9]{10}$/.test(selected.keyId) || typeof selected.privateKey !== "string") throw failed()
  const key = createPrivateKey(selected.privateKey)
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw failed()
  return { ...selected, key }
}
function aad(context: Context, record: AppleRevocationRecord, keyId: string) {
  return Buffer.from(JSON.stringify(["cyntch-apple-revocation-v1", context.instanceId, context.requestId, context.accountId, record.externalId, record.clientId, keyId]))
}
function seal(context: Context, record: AppleRevocationRecord, token: string, config: AppleRevocationConfig): SealedToken {
  const keyId = config.tokenKeys?.current, iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(config, keyId), iv)
  cipher.setAAD(aad(context, record, keyId))
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()])
  return { keyId, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") }
}
function unseal(context: Context, record: AppleRevocationRecord, config: AppleRevocationConfig) {
  const sealed = record.credential!
  const iv = decode(sealed.iv, 12), tag = decode(sealed.tag, 16)
  if (iv.length !== 12 || tag.length !== 16) throw failed()
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(config, sealed.keyId), iv)
  decipher.setAAD(aad(context, record, sealed.keyId)); decipher.setAuthTag(tag)
  const token = Buffer.concat([decipher.update(decode(sealed.ciphertext, 16_000)), decipher.final()]).toString("utf8")
  if (!text(token, 16_000)) throw failed()
  return token
}
function clientSecret(config: AppleRevocationConfig, clientId: string) {
  const selected = client(config, clientId), issuedAt = Math.floor(Date.now() / 1000)
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const input = `${encoded({ alg: "ES256", kid: selected.keyId })}.${encoded({ iss: selected.teamId, iat: issuedAt, exp: issuedAt + 300, aud: "https://appleid.apple.com", sub: clientId })}`
  return `${input}.${sign("sha256", Buffer.from(input), { key: selected.key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`
}

/** Credentials are obtained only from authenticated Clerk BAPI, never client
 * claims. A returned ID token selects an explicitly configured Apple client;
 * decoding it here does not authenticate a user or grant any application access.
 * Save encrypted credentials BEFORE revocation: Clerk may be unable to refresh
 * them once Apple has accepted a request whose response was lost. */
export async function revokeAccountAppleIdentity(context: Context) {
  const records = context.records.map(record => ({ ...record }))
  if (records.some(record => !text(record.externalId) || !["pending", "revoked", "manual"].includes(record.status)) ||
    new Set(records.map(record => record.externalId)).size !== records.length || new Set(context.accounts.map(account => account.id)).size !== context.accounts.length) throw failed()
  for (const account of context.accounts) {
    if (!text(account.id) || !text(account.providerUserId, 1500)) throw failed()
    if (!records.some(record => record.externalId === account.id)) records.push({ externalId: account.id, status: "pending" })
  }
  if (!records.length) return records
  await context.save(records)
  let config = context.config, tokens: Json[] | null | undefined
  for (let index = 0; index < records.length; index++) {
    let record = records[index]
    if (record.status !== "pending") continue
    if (!record.credential) {
      if (tokens === undefined) tokens = context.userExists ? await context.tokens() : null
      const matches = tokens?.filter(token => token.external_account_id === record.externalId) ?? []
      if (matches.length > 1) throw failed()
      if (!matches.length) {
        // Apple's TN3194 says to fulfil erasure when tokens are unavailable
        // and direct the user to manually revoke. Persist that honest outcome.
        records[index] = { externalId: record.externalId, status: "manual" }
        await context.save(records); continue
      }
      const token = matches[0], account = context.accounts.find(account => account.id === record.externalId)
      if (!account || token.object !== "oauth_access_token" || !["apple", "oauth_apple"].includes(String(token.provider)) ||
        token.provider_user_id !== account.providerUserId || !text(token.token, 16_000) || !text(token.id_token, 20_000)) throw failed()
      const parts = token.id_token.split(".")
      if (parts.length !== 3) throw failed()
      const claims = object(JSON.parse(decode(parts[1], 12_000).toString("utf8")))
      if (claims.iss !== "https://appleid.apple.com" || claims.sub !== account.providerUserId || !text(claims.aud)) throw failed()
      config ??= configured(); client(config, claims.aud)
      record = { ...record, clientId: claims.aud }
      record.credential = seal(context, record, token.token, config)
      records[index] = record
      await context.save(records)
    }
    config ??= configured()
    if (!record.clientId) throw failed()
    const token = unseal(context, record, config)
    const body = new URLSearchParams({ client_id: record.clientId, client_secret: clientSecret(config, record.clientId), token, token_type_hint: "access_token" })
    const response = await context.fetcher("https://appleid.apple.com/auth/revoke", { method: "POST", body,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, redirect: "error", cache: "no-store", signal: await context.signal() })
    // Apple documents empty 200 for successful OR previously completed
    // revocation. An error response is never treated as successful erasure.
    if (response.status !== 200 || (await response.text()).trim() !== "") throw failed()
    records[index] = { externalId: record.externalId, status: "revoked" }
    await context.save(records)
  }
  return records
}
