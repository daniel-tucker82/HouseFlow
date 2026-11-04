import { requireOptionalNativeModule } from "expo"

export interface NativeClerkAccountState {
  format: 1
  ready: boolean
  hasAccount: boolean
  hasUnidentifiedSession: boolean
  hasAuthenticationSnapshot: boolean
}
interface ClerkBridge { getAuthFlowState(): Promise<{isLoaded:boolean}>; refreshClient(): Promise<void> }
interface StateBridge { inspectAccount(accountId: string): Promise<unknown>; inspectPersistence(accountId: string): Promise<unknown> }
const unavailable = () => new Error("Native sign-in cleanup could not be verified. Keep the saved deletion receipt and try again.")

function parseState(value: unknown): NativeClerkAccountState {
  const state = value as Partial<NativeClerkAccountState> | null
  if (!state || state.format !== 1 || [state.ready,state.hasAccount,state.hasUnidentifiedSession,state.hasAuthenticationSnapshot].some(value => typeof value !== "boolean")) throw unavailable()
  return {format:1,ready:state.ready!,hasAccount:state.hasAccount!,hasUnidentifiedSession:state.hasUnidentifiedSession!,hasAuthenticationSnapshot:state.hasAuthenticationSnapshot!}
}

/** Reads only the native SDK that ClerkProvider already configured. An absent
 * module or loading SDK is unknown, never proof of a cleared account. */
export async function inspectNativeClerkAccount(accountId: string, refresh = false): Promise<NativeClerkAccountState> {
  try {
    if (!/^user_[A-Za-z0-9_-]{1,200}$/.test(accountId)) throw unavailable()
    const clerk = requireOptionalNativeModule<ClerkBridge>("ClerkExpo")
    const inspector = requireOptionalNativeModule<StateBridge>("CyntchClerkState")
    if (!clerk || !inspector || !(await clerk.getAuthFlowState()).isLoaded) throw unavailable()
    if (refresh) await clerk.refreshClient()
    if (!(await clerk.getAuthFlowState()).isLoaded) throw unavailable()
    return parseState(await inspector.inspectAccount(accountId))
  } catch {throw unavailable()}
}

/** Inspect the SDK's persisted profile separately from its in-memory client.
 * Old native builds cannot silently bypass this new cleanup checkpoint. */
export async function inspectNativeClerkPersistence(accountId: string): Promise<NativeClerkAccountState> {
  try {
    if (!/^user_[A-Za-z0-9_-]{1,200}$/.test(accountId)) throw unavailable()
    const clerk = requireOptionalNativeModule<ClerkBridge>("ClerkExpo")
    const inspector = requireOptionalNativeModule<StateBridge>("CyntchClerkState")
    if (!clerk || !inspector || typeof inspector.inspectPersistence !== "function" || !(await clerk.getAuthFlowState()).isLoaded) throw unavailable()
    const state = parseState(await inspector.inspectPersistence(accountId))
    if (!(await clerk.getAuthFlowState()).isLoaded) throw unavailable()
    return state
  } catch {throw unavailable()}
}
