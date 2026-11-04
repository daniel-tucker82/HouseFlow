import { Alert } from "react-native"
import { useAuth } from "@clerk/expo"
import { AccountDeletionStatusView } from "./account-deletion-status"
import { useAccountDeletionRecovery } from "../providers/account-deletion-recovery"
import { useAccountDeletionActions } from "../providers/account-deletion-actions"
import { useNotificationSession } from "../providers/notification-session"

export function AccountDeletionRecoveryActions() {
  const {state} = useAccountDeletionRecovery(), actions = useAccountDeletionActions(), {signOut} = useNotificationSession()
  const {userId} = useAuth({treatPendingAsSignedOut:false})
  const record = state.record
  const report = (error: unknown) => Alert.alert("Request kept",error instanceof Error ? error.message : "Your saved request has been kept. Please try again.")
  return <><AccountDeletionStatusView busy={actions.busy} accountDeleted={Boolean(userId && state.deletedAccounts.includes(userId))} onSignOut={() => void signOut().catch(report)}
    onWithdraw={record && record.accountId === userId && record.submitted && !record.status ? () => Alert.alert("Withdraw this attempt?","Cyntch will stop this attempt only if deletion has not already been accepted. An accepted deletion cannot be cancelled.",[
      {text:"Keep request",style:"cancel"},{text:"Withdraw attempt",onPress:() => void actions.withdraw(record).catch(report)},
    ]) : undefined} />{actions.verification}</>
}
