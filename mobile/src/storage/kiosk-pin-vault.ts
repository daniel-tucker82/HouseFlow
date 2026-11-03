import { notificationUuid } from "../../../shared/mobile/notification-settings"

export interface KioskSecureStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}
export interface KioskPinCrypto {
  randomSecret(): Promise<string>
  digest(value: string): Promise<string>
}
interface PinRecord {
  format: 1; revision: number; pepper: string; verifier: string; exitSecret: string;
  attempts: number; cooldownMs: number;
}
const hexSecret = /^[a-f0-9]{64}$/
const queues = new Map<string, Promise<void>>()
function serial<T>(key: string, work: () => Promise<T>) {
  const result = (queues.get(key) ?? Promise.resolve()).then(work)
  const tail = result.then(() => undefined, () => undefined)
  queues.set(key, tail)
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return result
}
function cooldown(attempts: number) { return attempts < 5 ? 0 : Math.min(900_000, 30_000 * 2 ** Math.min(attempts - 5, 5)) }
function equal(left: string, right: string) {
  let difference = left.length ^ right.length
  for (let i = 0; i < 64; i++) difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0)
  return difference === 0
}
export class KioskPinError extends Error {
  constructor(message: string, readonly retryAfterMs = 0) { super(message); this.name = "KioskPinError" }
}

/** PIN verification and attempt reservations live only in the OS secure store.
 * The random pepper is a device secret, not a public password salt. No PIN or
 * low-entropy verifier is stored in SQLite or sent to the API. A compromised OS
 * keychain is outside the app-lock threat model; this is not device lockdown.
 */
export class KioskPinVault {
  private deadlines = new Map<string, { revision: number; until: number }>()
  constructor(private readonly storage: KioskSecureStorage, private readonly crypto: KioskPinCrypto,
    private readonly elapsedMs: () => number) {}
  private key(id: string) {
    if (!notificationUuid.test(id)) throw new KioskPinError("This kiosk PIN is unavailable. Sign in as the parent to recover access.")
    return `cyntch.kiosk-pin.${id}`
  }
  private parse(raw: string | null): PinRecord {
    let value: PinRecord | null = null
    try { value = raw ? JSON.parse(raw) : null } catch { /* Fail closed on missing/corrupt secure storage. */ }
    if (!value || value.format !== 1 || !hexSecret.test(value.pepper) || !hexSecret.test(value.verifier) || !hexSecret.test(value.exitSecret)
      || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.attempts) || value.attempts < 0
      || value.cooldownMs !== cooldown(value.attempts)) throw new KioskPinError("This kiosk PIN is unavailable. Sign in as the parent to recover access.")
    return value
  }
  private async digest(id: string, pepper: string, pin: string) {
    const digest = await this.crypto.digest(`cyntch:kiosk-pin:v1:${id}:${pepper}:${pin}`)
    if (!hexSecret.test(digest)) throw new KioskPinError("This device could not verify the PIN safely. Please try again.")
    return digest
  }
  private remaining(key: string, record: PinRecord) {
    if (!record.cooldownMs) { this.deadlines.delete(key); return 0 }
    let deadline = this.deadlines.get(key)
    // Restarting restarts the outstanding cooldown. Moving the wall clock cannot
    // shorten it, and no timer, polling loop or connectivity check is necessary.
    if (deadline?.revision !== record.revision) {
      deadline = { revision: record.revision, until: this.elapsedMs() + record.cooldownMs }
      this.deadlines.set(key, deadline)
    }
    return Math.max(0, Math.ceil(deadline.until - this.elapsedMs()))
  }
  async create(id: string, pin: string) {
    const key = this.key(id)
    if (!/^\d{6}$/.test(pin)) throw new KioskPinError("Choose a six-digit parent PIN.")
    return serial(key, async () => {
      if (await this.storage.get(key) !== null) throw new KioskPinError("This kiosk PIN is already configured.")
      const [pepper, exitSecret] = await Promise.all([this.crypto.randomSecret(), this.crypto.randomSecret()])
      if (!hexSecret.test(pepper) || !hexSecret.test(exitSecret)) throw new KioskPinError("This device could not create a protected kiosk key.")
      const record: PinRecord = { format: 1, revision: 1, pepper, verifier: await this.digest(id, pepper, pin), exitSecret, attempts: 0, cooldownMs: 0 }
      await this.storage.set(key, JSON.stringify(record))
      return exitSecret
    })
  }
  /** Background replay of an activation uses its original capability, never its PIN. */
  activationKey(id: string) {
    const key = this.key(id)
    return serial(key, async () => this.parse(await this.storage.get(key)).exitSecret)
  }
  waitRemaining(id: string) {
    const key = this.key(id)
    return serial(key, async () => this.remaining(key, this.parse(await this.storage.get(key))))
  }
  verify(id: string, pin: string): Promise<{ matched: true; exitSecret: string } | { matched: false; retryAfterMs: number }> {
    const key = this.key(id)
    return serial(key, async () => {
      const record = this.parse(await this.storage.get(key)), waiting = this.remaining(key, record)
      if (waiting > 0) throw new KioskPinError("Too many PIN attempts. Wait before trying again, or sign in as the parent to recover access.", waiting)
      const reserved: PinRecord = { ...record, revision: record.revision + 1, attempts: Math.min(record.attempts + 1, 1_000_000), cooldownMs: cooldown(record.attempts + 1) }
      // Commit BEFORE checking: killing the process during verification consumes
      // the attempt instead of restoring a free guess at the next launch.
      await this.storage.set(key, JSON.stringify(reserved))
      this.remaining(key, reserved)
      const valid = /^\d{6}$/.test(pin) && equal(record.verifier, await this.digest(id, record.pepper, pin))
      if (!valid) return { matched: false, retryAfterMs: this.remaining(key, reserved) }
      await this.storage.set(key, JSON.stringify({ ...reserved, revision: reserved.revision + 1, attempts: 0, cooldownMs: 0 } satisfies PinRecord))
      this.deadlines.delete(key)
      return { matched: true, exitSecret: record.exitSecret }
    })
  }
  /** Only after the corresponding server unlock/recovery has been acknowledged. */
  remove(id: string) {
    const key = this.key(id)
    return serial(key, async () => { await this.storage.remove(key); this.deadlines.delete(key) })
  }
}
