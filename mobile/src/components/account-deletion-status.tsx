import { Alert, ScrollView, View } from "react-native"
import * as Linking from "expo-linking"
import { SafeAreaView } from "react-native-safe-area-context"
import { Action, Card, Copy, styles, usePalette } from "./ui"
import { useAccountDeletionRecovery } from "../providers/account-deletion-recovery"

export function AccountDeletionStatusView({onClose,onWithdraw,onSignOut,onReview,busy = false,readOnly = false,accountDeleted = false}: {
  onClose?: () => void; onWithdraw?: () => void; onSignOut?: () => void; onReview?: () => void; busy?: boolean; readOnly?: boolean; accountDeleted?: boolean
}) {
  const {controller,state} = useAccountDeletionRecovery(), colors = usePalette()
  const record = state.record, status = record?.status, working = busy || state.busy
  const open = (url: string) => void Linking.openURL(url).catch(() => Alert.alert("Unable to open settings","Please try again or open the provider’s account settings."))
  return <SafeAreaView style={{flex:1,backgroundColor:colors.background}}><ScrollView contentContainerStyle={styles.content}>
    <Copy tone="title">{status?.state === "completed" ? "Account deleted" : status ? "Deletion requested" : record?.submitted ? "Check your deletion request" : "Account deletion"}</Copy>
    <Card>
      <Copy>{status?.state === "completed" ? "Cyntch has confirmed that your account deletion is complete." : status ? "Your request has been accepted. Cyntch is removing your account and its associated data. You can close the app and check back later." : record?.submitted
        ? "Your request is saved, but acceptance has not been confirmed. Check its status, or withdraw this attempt before making another request. Closing the app does not cancel it."
        : record ? "Your choices are saved on this device. Deletion has not been submitted. You can return to the review or cancel these saved choices."
        : accountDeleted ? "Deletion was accepted for this account. Its saved receipt has been removed from this device. Sign out to continue with another account." : "There is no saved deletion request on this device."}</Copy>
      {status ? <Copy tone="muted">Requested {new Date(status.acceptedAt).toLocaleString()}{status.completedAt ? `\nCompleted ${new Date(status.completedAt).toLocaleString()}` : ""}</Copy> : null}
      {state.error ? <View accessibilityRole="alert"><Copy style={{color:colors.danger}}>{state.error}</Copy></View> : null}
      {record?.submitted ? <Action label={working ? "Checking…" : "Check status"} disabled={working} onPress={() => void controller.check().catch(() => undefined)} /> : null}
      {(record?.status || state.deletedAccounts.length > 0) && !state.localCleanupComplete ? <Action secondary label="Retry device cleanup" disabled={working} onPress={() => void controller.recoverIdentity().catch(() => undefined)} /> : null}
      {record && !record.submitted ? <>
        {onReview ? <Action label="Return to review" disabled={working} onPress={onReview} /> : null}
        {!readOnly ? <Action secondary label="Cancel saved choices" disabled={working} onPress={() => Alert.alert("Cancel these choices?","No deletion has been submitted. Your account and households will stay as they are.",[
          {text:"Keep choices",style:"cancel"},{text:"Cancel choices",onPress:() => void controller.cancelPrepared(record).catch(() => undefined)},
        ])} /> : null}
      </> : null}
      {record?.submitted && !status && onWithdraw ? <Action secondary label="Withdraw this attempt" disabled={working} onPress={onWithdraw} /> : null}
    </Card>
    {record?.submitted ? <Card><Copy tone="heading">Store subscriptions</Copy><Copy>Deleting Cyntch does not cancel Apple or Google Play subscriptions. Check each store that bills you, even if you use a different device now.</Copy>
      <Action secondary label="Manage Apple subscriptions" onPress={() => open("https://apps.apple.com/account/subscriptions")} />
      <Action secondary label="Manage Google Play subscriptions" onPress={() => open("https://play.google.com/store/account/subscriptions")} />
    </Card> : null}
    {status?.appleRevocationRequired ? <Card><Copy tone="heading">Disconnect Sign in with Apple</Copy><Copy>Apple access still needs your attention. Follow Apple’s steps to stop using Sign in with Apple for Cyntch.</Copy>
      <Action secondary label="Open Apple’s instructions" onPress={() => open("https://support.apple.com/en-us/102571")} /></Card> : null}
    {!readOnly && status?.state === "completed" && state.localCleanupComplete && record ? <Action secondary label="Remove saved receipt" disabled={working} onPress={() => Alert.alert("Remove this receipt?","This removes deletion status from this device. It does not cancel any store subscription or undo deletion. Check the subscription and Apple instructions above first.",[
      {text:"Keep receipt",style:"cancel"},{text:"Remove receipt",onPress:() => void controller.dismissCompleted(record).catch(() => undefined)},
    ])} /> : null}
    {onSignOut ? <Action secondary label="Sign out" disabled={working} onPress={onSignOut} /> : null}
    {onClose ? <Action secondary label="Close" disabled={busy} onPress={onClose} /> : null}
  </ScrollView></SafeAreaView>
}
