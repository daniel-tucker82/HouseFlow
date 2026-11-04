import { useAccountDeletionRecovery } from "../providers/account-deletion-recovery"
import { Action, Card, Copy } from "./ui"

/** A dismissed receipt must not hide a failed cleanup attempt. Other household
 * members can keep using the app while this account-scoped repair runs. */
export function AccountCleanupNotice() {
  const {controller,state} = useAccountDeletionRecovery()
  if (state.record || !state.deletedAccounts.length || state.localCleanupComplete) return null
  return <Card><Copy tone="heading">Saved sign-in details</Copy>
    <Copy>{state.busy ? "Checking this device for details from a deleted account…" : "Some saved sign-in details from a deleted account still need to be removed."}</Copy>
    <Action secondary label={state.busy ? "Checking…" : "Retry device cleanup"} disabled={state.busy}
      onPress={() => void controller.recoverIdentity().catch(() => undefined)} />
  </Card>
}
