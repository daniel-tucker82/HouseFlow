import { validInvitationLimits, type InvitationPage } from "../../../shared/mobile/invitations"
import type { MobileApi } from "./api"

type State = { page: InvitationPage | null; busy: boolean; ready: boolean; error: string | null; message: string | null }
/** No polling or persisted invitation secrets. Late reads cannot restore a hidden/locked household. */
export class InvitationController {
  private state: State = { page: null, busy: false, ready: false, error: null, message: null }
  private listeners = new Set<() => void>()
  private enabled = false
  private generation = 0
  private mutation = false
  constructor(private api: Pick<MobileApi, "invitations" | "request">, private householdId: string) {}
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()) }
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return
    this.enabled = enabled; this.generation++
    this.update({ page: null, ready: false, busy: this.mutation, error: null, message: null })
    if (enabled && !this.mutation) void this.refresh()
  }
  private current(generation: number) { return this.enabled && generation === this.generation }
  async refresh(more = false) {
    if (!this.enabled || this.state.busy || (more && !this.state.page?.nextCursor)) return
    const generation = this.generation, previous = more ? this.state.page : null
    this.update({ busy: true, error: null, ready: false, ...(more ? {} : { page: null }) })
    try {
      const page = await this.api.invitations(this.householdId, previous?.nextCursor ?? undefined)
      if (!this.current(generation)) return
      const items = [...(previous?.items ?? []), ...page.items]
      this.update({ page: { ...page, items: items.filter((item, index) => items.findIndex(other => other.id === item.id) === index) }, ready: true })
    } catch (error) {
      if (this.current(generation)) this.update({ page: null, error: error instanceof Error ? error.message : "Unable to load invitations." })
    } finally { if (this.current(generation)) this.update({ busy: false }) }
  }
  async create(maxUses: number, expiresInDays: number) {
    if (!validInvitationLimits(maxUses, expiresInDays)) {
      if (this.enabled) this.update({ error: "Choose 1–100 uses and an expiry of 1–365 days." })
      return
    }
    await this.change("createInvite", { maxUses, expiresInDays }, "Invitation created.")
  }
  async revoke(inviteId: string) {
    if (!this.state.page?.items.some(item => item.id === inviteId)) return
    await this.change("deactivateInvite", { inviteId }, "Invitation revoked. Existing members still belong to your household.")
  }
  prepareRevocation(inviteId: string) {
    const generation = this.generation
    // A native alert may outlive its screen or a kiosk/connection interruption.
    // Returning to the same household must not reactivate an older confirmation.
    return async () => { if (this.current(generation)) await this.revoke(inviteId) }
  }
  private async change(action: string, values: Record<string, unknown>, message: string) {
    if (!this.enabled || this.state.busy || !this.state.ready || this.mutation) return
    const generation = this.generation
    this.mutation = true
    this.update({ busy: true, ready: false, error: null, message: null })
    let failure: string | null = null
    try {
      await this.api.request("/api/leader/flow", { action, householdId: this.householdId, ...values })
    } catch (error) {
      failure = `${error instanceof Error ? error.message : "Unable to confirm the change."} Check the refreshed invitation list before trying again.`
    } finally {
      this.mutation = false
      // Refresh even if the response was lost: creation is never automatically repeated.
      if (this.enabled) {
        this.update({ busy: false })
        await this.refresh()
        if (this.current(generation)) this.update(failure ? { error: failure } : { message })
      } else this.update({ busy: false })
    }
  }
}
