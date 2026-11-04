import { useState } from "react"
import { Alert, ScrollView, Switch, TextInput, View } from "react-native"
import { AppModal } from "./app-modal"
import { SafeAreaView } from "react-native-safe-area-context"
import { useKiosk } from "../providers/kiosk"
import { useBoard } from "../providers/runtime"
import { Action, Card, Copy, styles, usePalette } from "./ui"

export function ParentPinInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const colors = usePalette()
  return <View style={{ gap: 8 }}><Copy tone="label">{label}</Copy><TextInput accessibilityLabel={label} value={value} onChangeText={text => onChange(text.replace(/\D/g, "").slice(0, 6))}
    secureTextEntry keyboardType="number-pad" maxLength={6} autoComplete="off" autoCorrect={false} textContentType="none"
    style={{ minHeight: 52, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, fontSize: 22, color: colors.text, backgroundColor: colors.surface }} /></View>
}
export function KioskSettingsCard() {
  const board = useBoard(), { controller, state } = useKiosk(), colors = usePalette()
  const [open, setOpen] = useState(false), [visible, setVisible] = useState<string[]>([]), [editable, setEditable] = useState<string[]>([])
  const [pin, setPin] = useState(""), [confirm, setConfirm] = useState("")
  const members = board.board?.members ?? [], household = board.board?.household
  if (!household || household.role !== "manager") return null
  const close = () => { setOpen(false); setPin(""); setConfirm("") }
  async function enable() {
    if (!household || pin !== confirm) { Alert.alert("Check the PIN", "Enter the same six-digit PIN in both fields."); return }
    try { await controller.activate({ householdId: household.id, visibleMemberIds: visible, editableMemberIds: editable }, pin); close() }
    catch (error) { Alert.alert("Kiosk mode needs attention", error instanceof Error ? error.message : "Please try again.") }
  }
  return <>
    <Card><Copy tone="heading">Family display</Copy><Copy tone="muted">Choose whose tasks can be seen and updated on this device. A parent PIN protects Cyntch’s other controls.</Copy>
      <Copy tone="muted">People can still leave Cyntch and use other apps.</Copy>
      <Action label={state.record ? "Finishing kiosk unlock…" : "Set up kiosk mode"} disabled={!board.online || Boolean(state.record)} onPress={() => {
        setVisible(members.map(member => member.id)); setEditable(members.map(member => member.id)); setPin(""); setConfirm(""); setOpen(true)
      }} />
      {!board.online ? <Copy tone="muted">Connect to set up this device. Task updates and PIN unlocking will work offline afterward.</Copy> : null}
    </Card>
    <AppModal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Copy tone="title">Set up family display</Copy><Copy tone="muted">These choices apply only to this device.</Copy>
        {members.map(member => <Card key={member.id}><Copy tone="heading">{member.name}</Copy>
          <View style={[styles.row, { justifyContent: "space-between" }]}><Copy>Show tasks</Copy><Switch accessibilityLabel={`Show tasks for ${member.name}`} value={visible.includes(member.id)} onValueChange={enabled => {
            setVisible(values => enabled ? [...values, member.id] : values.filter(id => id !== member.id)); if (!enabled) setEditable(values => values.filter(id => id !== member.id))
          }} /></View>
          <View style={[styles.row, { justifyContent: "space-between" }]}><Copy style={{ flex: 1 }}>Allow completion and reopening</Copy><Switch accessibilityLabel={`Allow task updates for ${member.name}`} disabled={!visible.includes(member.id)} value={editable.includes(member.id)} onValueChange={enabled => setEditable(values => enabled ? [...values, member.id] : values.filter(id => id !== member.id))} /></View>
        </Card>)}
        <ParentPinInput label="Parent PIN (six digits)" value={pin} onChange={setPin} />
        <ParentPinInput label="Confirm parent PIN" value={confirm} onChange={setConfirm} />
        <Copy tone="muted">Keep this PIN private. If you forget it, you can recover access by signing in to your parent account while online.</Copy>
        <Action label="Enable kiosk mode" disabled={!visible.length || pin.length !== 6 || confirm.length !== 6 || state.changing} onPress={() => void enable()} />
        <Action secondary label="Cancel" onPress={close} />
      </ScrollView></SafeAreaView>
    </AppModal>
  </>
}
