import { parseNativeKioskSession, type NativeKioskOperation, type NativeKioskResult } from "../../../shared/mobile/kiosk"
import { nextKioskCommand, type KioskStore, type LocalKiosk } from "../storage/kiosk-store"
import { KioskPinError, type KioskPinVault } from "../storage/kiosk-pin-vault"
import { TransportError } from "../storage/sync-engine"

export interface KioskIdentity { accountId: string; sessionId: string }
interface KioskApi { saveKiosk(operation: NativeKioskOperation): Promise<NativeKioskResult> }
interface KioskState { ready: boolean; changing: boolean; syncing: boolean; online: boolean; record: LocalKiosk | null; error: string | null }
function sameIdentity(left: KioskIdentity | null, right: KioskIdentity | null) {
  return left?.accountId === right?.accountId && left?.sessionId === right?.sessionId
}
export class KioskController {
  private state: KioskState = { ready: false, changing: false, syncing: false, online: false, record: null, error: null }
  private identity: KioskIdentity | null = null
  private listeners = new Set<() => void>()
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = true
  private stopped = false
  constructor(private readonly store: KioskStore, private readonly vault: KioskPinVault, private readonly deviceId: string,
    private readonly api: (identity: KioskIdentity) => KioskApi, private readonly uuid: () => string, private readonly now: () => number = Date.now) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<KioskState>) { if (!this.stopped) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()) } }
  private async reload() { const record = await this.store.get(); this.update({ record, ready: true, error: record?.error ?? null }) }
  async start() {
    try { await this.reload(); this.wake() }
    catch (error) { this.update({ ready: false, error: error instanceof Error ? error.message : "The device lock could not be opened safely." }) }
  }
  setIdentity(identity: KioskIdentity | null) { this.identity = identity; this.wake() }
  setConnectivity(online: boolean) { this.update({ online }); if (!online) clearTimeout(this.timer); else this.wake() }
  setActive(active: boolean) { this.active = active; if (!active) clearTimeout(this.timer); else this.wake() }
  async activate(settings: { householdId: string; visibleMemberIds: string[]; editableMemberIds: string[] }, pin: string) {
    if (!this.state.ready || this.state.changing || this.state.record) throw new Error("Finish the current device lock before enabling kiosk mode.")
    const identity = this.identity
    if (!identity || !this.state.online) throw new Error("Connect and sign in as a parent to enable kiosk mode.")
    const kiosk = parseNativeKioskSession({ ...settings, ...identity, deviceId: this.deviceId, id: this.uuid(), state: "locked" })
    this.update({ changing: true, error: null })
    try {
      await this.vault.create(kiosk.id, pin)
      if (!sameIdentity(identity, this.identity) || this.stopped) throw new Error("Your sign-in changed. Try enabling kiosk mode again.")
      await this.store.begin(kiosk)
      await this.reload()
    } catch (error) {
      // A failed native commit can have an uncertain outcome. Inspect the durable
      // lock before removing its credential; an unreadable database stays closed.
      try {
        const current = await this.store.get()
        if (current?.kiosk.id !== kiosk.id) await this.vault.remove(kiosk.id)
        await this.reload()
      } catch { this.update({ ready: false }) }
      this.update({ error: error instanceof Error ? error.message : "Kiosk mode could not be enabled." })
      throw error
    } finally { this.update({ changing: false }); this.wake() }
  }
  async unlock(pin: string) {
    const current = this.state.record
    if (!current || this.state.changing) return
    if (current.intent === "recover") throw new Error("Finish parent sign-in to recover this kiosk.")
    const result = await this.vault.verify(current.kiosk.id, pin)
    if (!result.matched) throw new KioskPinError("That PIN did not match. Please try again.", result.retryAfterMs)
    await this.store.requestUnlock(current.kiosk.id)
    await this.reload(); this.wake()
  }
  async beginRecovery() {
    const current = this.state.record
    if (!current) return
    if (!this.state.online) throw new Error("Connect to the internet to recover the parent PIN.")
    await this.store.requestRecovery(current.kiosk.id, this.identity?.sessionId ?? null)
    await this.reload(); this.wake()
  }
  async retry() {
    try {
      if (this.state.record) await this.store.retry(this.state.record.kiosk.id)
      await this.reload(); this.wake()
    } catch (error) { this.update({ ready: false, error: error instanceof Error ? error.message : "The device lock could not be read safely." }) }
  }
  private eligible(record: LocalKiosk) {
    if (!this.identity || record.kiosk.accountId !== this.identity.accountId) return false
    return record.intent === "recover" ? record.kiosk.sessionId !== this.identity.sessionId && record.recoverySignOutSessionId !== this.identity.sessionId : record.kiosk.sessionId === this.identity.sessionId
  }
  private wake() {
    clearTimeout(this.timer)
    if (this.running || this.stopped || !this.active || !this.state.ready || !this.state.online || this.state.changing) return
    const record = this.state.record
    if (!record || record.blocked || !this.eligible(record) || !nextKioskCommand(record)) return
    const delay = record.nextAttemptMs - this.now()
    if (delay > 0) { this.timer = setTimeout(() => this.wake(), Math.min(delay, 60_000)); return }
    this.running = this.sync().catch(error => this.update({ ready: false, error: error instanceof Error ? error.message : "Kiosk mode could not be synced safely." })).finally(() => {
      this.running = null; this.update({ syncing: false }); this.wake()
    })
  }
  private async sync() {
    const current = await this.store.get(), identity = this.identity
    this.update({ record: current })
    if (!current || !identity || !this.eligible(current) || this.stopped) return
    const command = nextKioskCommand(current)
    if (!command) return
    this.update({ syncing: true })
    const kiosk = current.kiosk
    try {
      let operation: NativeKioskOperation
      if (command === "recover") operation = { action: "recover", id: kiosk.id, previousSessionId: kiosk.sessionId }
      else {
        const exitSecret = await this.vault.activationKey(kiosk.id)
        operation = command === "activate" ? { action: "activate", id: kiosk.id, householdId: kiosk.householdId,
          visibleMemberIds: kiosk.visibleMemberIds, editableMemberIds: kiosk.editableMemberIds, exitSecret } : { action: "unlock", id: kiosk.id, exitSecret }
      }
      if (this.stopped || !this.active || !this.state.online || !sameIdentity(identity, this.identity)) return
      const result = await this.api(identity).saveKiosk(operation)
      if (this.stopped || !sameIdentity(identity, this.identity)) return
      await this.store.acknowledge(kiosk.id, command, result)
      if (!await this.store.get()) {
        // A deletion failure leaves an unused, unguessable credential. It must
        // not recreate a lock which the server and local store have both ended.
        await this.vault.remove(kiosk.id).catch(() => undefined)
      }
    } catch (error) {
      if (this.stopped || !sameIdentity(identity, this.identity)) return
      const blocked = error instanceof KioskPinError || (error instanceof TransportError && [400,401,403,404,409,410,422].includes(error.status))
      await this.store.defer(kiosk.id, command, error instanceof Error ? error.message : "Waiting to sync this device lock.", this.now(), blocked)
    }
    await this.reload()
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.listeners.clear() }
}
