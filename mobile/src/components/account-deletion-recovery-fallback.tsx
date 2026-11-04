import { useState } from "react"
import { Modal, View } from "react-native"
import { useAccountDeletionRecovery } from "../providers/account-deletion-recovery"
import { useKiosk } from "../providers/kiosk"
import { Action, styles } from "./ui"
import { AccountDeletionStatusView } from "./account-deletion-status"

/** Read-only status access while Clerk or notification-session startup is
 * unavailable. No sign-in is needed, and an existing kiosk still wins. */
export function AccountDeletionRecoveryFallback() {
  const {state} = useAccountDeletionRecovery(), kiosk = useKiosk()
  const [open,setOpen] = useState(false)
  if (!state.record?.submitted || !kiosk.state.ready || kiosk.state.changing || kiosk.state.record) return null
  return <View style={styles.content}><Action secondary label="Check saved account deletion" onPress={() => setOpen(true)} />
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
      <AccountDeletionStatusView readOnly onClose={() => setOpen(false)} />
    </Modal>
  </View>
}
