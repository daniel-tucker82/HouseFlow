import { parseSafetyDraft, parseSafetyReceipt, parseSafetyReport, type SafetyReportDraft, type SafetyReportReceipt } from "../../../shared/mobile/safety-reports"
import type { LocalStore } from "../storage/local-store"

interface SavedReport { version: 1; draft: SafetyReportDraft | null; pending: boolean; receipt: SafetyReportReceipt | null }
interface State extends SavedReport { ready: boolean; saving: number; saved: boolean; sending: boolean; available: boolean; error: string | null }
interface Transport { safetyReportingAvailable(): Promise<boolean>; sendSafetyReport(draft: SafetyReportDraft): Promise<SafetyReportReceipt> }
const key = "safety-report-v1"

/** One account-scoped draft, frozen before its first send. Retries use the same ID. */
export class SafetyReportController {
  private state: State = { version: 1, draft: null, pending: false, receipt: null, ready: false, saving: 0, saved: true, sending: false, available: false, error: null }
  private listeners = new Set<() => void>()
  private writes: Promise<void> = Promise.resolve()
  private revision = 0
  private online = false
  private active = true
  private stopped = false
  private checking = false
  constructor(private store: Pick<LocalStore, "setting" | "saveSetting">, private accountId: string, private api: Transport,
    private uuid: () => string, private canUse: () => boolean) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(patch: Partial<State>) { this.state = { ...this.state, ...patch }; if (!this.stopped) this.listeners.forEach(listener => listener()) }
  private usable() { return !this.stopped && this.canUse() }
  private data(): SavedReport { return { version: 1, draft: this.state.draft, pending: this.state.pending, receipt: this.state.receipt } }
  private persist(data = this.data()) {
    const revision = ++this.revision
    this.publish({ saving: this.state.saving + 1, saved: false })
    const write = this.writes.then(() => this.store.saveSetting(this.accountId, key, data))
    this.writes = write.catch(() => undefined)
    return write.then(() => { if (revision === this.revision) this.publish({ saved: true }) }, error => {
      this.publish({ error: "This device could not save your report. Keep this screen open and try again." }); throw error
    }).finally(() => this.publish({ saving: this.state.saving - 1 }))
  }
  async start() {
    try {
      const saved = await this.store.setting<SavedReport>(this.accountId, key)
      if (this.stopped) return
      if (saved) {
        if (saved.version !== 1 || typeof saved.pending !== "boolean" || (saved.pending && !saved.draft)) throw new Error("Invalid saved report")
        const draft = saved.draft ? (saved.pending ? parseSafetyReport(saved.draft) : parseSafetyDraft(saved.draft)) : null
        const receipt = saved.receipt ? parseSafetyReceipt(saved.receipt, this.accountId, { ...saved.receipt, kind: "other", subject: "", message: "" }) : null
        this.publish({ draft, pending: saved.pending, receipt })
      }
      this.publish({ ready: true })
      void this.flush()
    } catch { this.publish({ error: "Your saved report could not be opened. It has not been overwritten." }) }
  }
  stop() { this.stopped = true; this.listeners.clear() }
  setConnectivity(online: boolean) { const changed = online !== this.online; this.online = online; if (changed && online) void this.flush() }
  setActive(active: boolean) { const changed = active !== this.active; this.active = active; if (changed && active) void this.flush() }
  async checkAvailability() {
    if (!this.usable() || !this.online || this.checking) return
    this.checking = true
    try { const available = await this.api.safetyReportingAvailable(); if (this.usable()) this.publish({ available }) }
    catch { if (this.usable()) this.publish({ available: false }) }
    finally { this.checking = false }
  }
  async begin(householdId: string) {
    if (!this.usable() || !this.state.ready || this.state.draft) throw new Error("Finish the saved report before starting another.")
    this.publish({ draft: parseSafetyDraft({ id: this.uuid(), householdId, kind: "content", subject: "", message: "" }), pending: false, receipt: null, error: null })
    await this.persist()
  }
  async edit(patch: Partial<Pick<SafetyReportDraft, "kind" | "subject" | "message">>) {
    if (!this.usable() || !this.state.ready || !this.state.draft || this.state.pending) throw new Error("This report is waiting for confirmation and cannot be edited.")
    this.publish({ draft: parseSafetyDraft({ ...this.state.draft, ...patch }), error: null })
    await this.persist()
  }
  async discard() {
    if (!this.usable() || !this.state.ready || this.state.pending) throw new Error("Confirm the pending report before clearing it.")
    const draft = this.state.draft
    await this.persist({ ...this.data(), draft: null })
    if (this.state.draft === draft && !this.state.pending) this.publish({ draft: null, error: null })
  }
  async submit() {
    if (!this.usable() || !this.state.ready || !this.state.draft) throw new Error("Open a report first.")
    const draft = parseSafetyReport(this.state.draft)
    this.publish({ draft, pending: true, error: null })
    await this.persist()
    void this.flush()
  }
  async flush() {
    if (!this.usable() || !this.active || !this.online || !this.state.ready || !this.state.pending || !this.state.draft || this.state.sending) return
    const draft = this.state.draft
    this.publish({ sending: true, error: null })
    try {
      // Also protects retries after a local write failure. No network before commit.
      await this.persist()
      if (!this.usable() || !this.active || !this.online) return
      const receipt = parseSafetyReceipt(await this.api.sendSafetyReport(draft), this.accountId, draft)
      if (!this.usable()) return
      await this.persist({ version: 1, draft: null, pending: false, receipt })
      this.publish({ draft: null, pending: false, receipt, available: true })
    } catch (error) {
      if (this.usable()) {
        // These definitive rejections were not accepted as this operation.
        // A network failure or mismatched receipt remains frozen for retry.
        const status = (error as { status?: number } | null)?.status
        if (status && [400, 403, 409].includes(status)) {
          try { await this.persist({ ...this.data(), pending: false }); this.publish({ pending: false }) }
          catch { /* Keep the frozen report until a durable write succeeds. */ }
        }
        this.publish({ error: error instanceof Error ? error.message : "Your report could not be confirmed. Retry your saved report." })
      }
    } finally { this.publish({ sending: false }) }
  }
}
