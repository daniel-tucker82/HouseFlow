import { SecureResourceStore } from "./secure-resource-store"

type Kind = "environment" | "client" | "session_jwt"
type Row = Record<string, unknown>
const row = (value: unknown): value is Row => Boolean(value && typeof value === "object" && !Array.isArray(value))
const account = (value: unknown): value is string => typeof value === "string" && /^user_[A-Za-z0-9_-]{1,200}$/.test(value)
const unavailable = () => new Error("Saved sign-in information needs another attempt.")

/** This reads a JWT solely to discard deleted-account cache entries. It never
 * authenticates a token, extends its lifetime or changes any token claims. */
function tokenAccount(value: unknown) {
  if (typeof value !== "string" || value.length > 32768) return null
  try {
    const parts = value.split(".")
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null
    const body = parts[1].replace(/-/g,"+").replace(/_/g,"/")
    const parsed = JSON.parse(atob(body.padEnd(Math.ceil(body.length / 4) * 4,"=")))
    return row(parsed) && account(parsed.sub) ? parsed.sub : null
  } catch {return null}
}
export function filterClerkOfflineResource(kind: Kind, value: string | null, deleted: ReadonlySet<string>): string | null {
  if (!value || kind === "environment" || !deleted.size) return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (kind === "session_jwt") {
      const owner = tokenAccount(parsed)
      return owner && !deleted.has(owner) ? value : null
    }
    if (!row(parsed) || parsed.object !== "client" || !Array.isArray(parsed.sessions)) return null
    const sessions = parsed.sessions.filter((session: unknown) => {
      if (!row(session) || session.object !== "session" || typeof session.id !== "string") return false
      const owner = row(session.user) ? session.user.id : row(session.public_user_data) ? session.public_user_data.user_id : null
      if (!account(owner) || deleted.has(owner)) return false
      const actor = row(session.actor) ? session.actor.sub : null
      if (typeof actor === "string" && deleted.has(actor)) return false
      const token = row(session.last_active_token) ? session.last_active_token.jwt : null
      return !token || tokenAccount(token) === owner
    }) as Row[]
    // Pending sign-in/up snapshots contain profile fields without an account ID.
    // Do not retain those ambiguous caches once this device has erased an account.
    // Clerk accepts null and rebuilds these resources; live auth flows are intact.
    return JSON.stringify({...parsed,sessions,sign_in:null,sign_up:null,
      last_active_session_id:sessions.some(session => session.id === parsed.last_active_session_id) ? parsed.last_active_session_id : null})
  } catch {return null}
}

/** One owner serializes SDK reads/writes and deletion cleanup. A durable account
 * fence is checked on every access, including delayed SDK writes after deletion.
 * Other accounts' sessions and their original signed tokens are preserved. */
export class ClerkOfflineCache {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly keys: Record<Kind,string>
  constructor(private readonly storage: SecureResourceStore, publishableKey: string, private readonly deletedAccounts: () => Promise<string[]>) {
    if (!/^pk_(test|live)_[A-Za-z0-9_-]+=*$/.test(publishableKey) || publishableKey.length > 400) throw unavailable()
    const suffix = publishableKey.replace(/=/g,"")
    this.keys = {environment:`__clerk_cache_environment_${suffix}`,client:`__clerk_cache_client_${suffix}`,session_jwt:`__clerk_cache_session_jwt_${suffix}`}
  }
  private serial<T>(work: () => Promise<T>) {
    const result = this.tail.then(work)
    this.tail = result.catch(() => undefined)
    return result
  }
  private kind(key: string): Kind {
    const kind = (Object.keys(this.keys) as Kind[]).find(kind => this.keys[kind] === key)
    if (!kind) throw unavailable()
    return kind
  }
  private async filteredRead(key: string, kind: Kind, deleted: ReadonlySet<string>) {
    const saved = await this.storage.read(key), filtered = filterClerkOfflineResource(kind,saved.value,deleted)
    if (saved.legacy || filtered !== saved.value) await this.storage.write(key,filtered)
    else await this.storage.clearLegacy(key)
    return filtered
  }
  get = (key: string) => this.serial(async () => {
    const kind = this.kind(key), deleted = new Set(await this.deletedAccounts())
    const value = await this.filteredRead(key,kind,deleted)
    // Erasure can commit in SQLite while keychain I/O is pending. The queued
    // cleanup will remove those bytes; do not return the stale profile first.
    return filterClerkOfflineResource(kind,value,new Set(await this.deletedAccounts()))
  })
  set = (key: string, value: string) => this.serial(async () => {
    const kind = this.kind(key), deleted = new Set(await this.deletedAccounts())
    await this.storage.write(key,filterClerkOfflineResource(kind,value,deleted))
  })
  eraseDeletedAccount(accountId: string) {
    return this.serial(async () => {
      const deleted = new Set(await this.deletedAccounts())
      if (!account(accountId) || !deleted.has(accountId)) throw new Error("Confirm account deletion before clearing saved sign-in information.")
      for (const kind of ["client","session_jwt"] as const) await this.filteredRead(this.keys[kind],kind,deleted)
    })
  }
}

/** The UI may time out, but the original operation keeps its place in the cache
 * queue. A retry can never overtake an unfinished keychain write or removal. */
export async function waitForClerkOfflineCleanup(work: Promise<void>, timeoutMs = 8_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {await Promise.race([work,new Promise<never>((_,reject) => {timeout=setTimeout(() => reject(unavailable()),timeoutMs)})])}
  finally {clearTimeout(timeout)}
}
