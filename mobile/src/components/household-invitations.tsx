import { useCallback, useState, useSyncExternalStore } from "react"
import { useFocusEffect } from "expo-router"
import { setStringAsync } from "expo-clipboard"
import { Alert, Share, TextInput, View } from "react-native"
import { invitationUrl, validInvitationLimits } from "../../../shared/mobile/invitations"
import { InvitationController } from "../services/invitation-controller"
import { useRuntime } from "../providers/runtime"
import { Action, Card, Copy, styles, usePalette } from "./ui"

export function HouseholdInvitations({ householdId, online }: { householdId: string; online: boolean }) {
  const { api, syncPaused } = useRuntime(), colors = usePalette()
  const [controller] = useState(() => new InvitationController(api, householdId))
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot)
  const [maxUses, setMaxUses] = useState("10"), [days, setDays] = useState("30")
  const [feedback, setFeedback] = useState<string | null>(null)
  const available = online && !syncPaused
  useFocusEffect(useCallback(() => {
    controller.setEnabled(available); setFeedback(null)
    return () => controller.setEnabled(false)
  }, [controller, available]))
  const disabled = !available || state.busy || !state.ready
  async function share(code: string, copy: boolean) {
    setFeedback(null)
    try {
      const link = invitationUrl(code)
      if (copy) { await setStringAsync(link, { android: { isSensitive: true } }); setFeedback("Invitation link copied.") }
      else await Share.share({ message: `Join our household on Cyntch: ${link}` })
    } catch { setFeedback(copy ? "Unable to copy the invitation. Please try again." : "Unable to share the invitation. Please try again.") }
  }
  return <Card><Copy tone="heading">Invite someone with an account</Copy>
    <Copy tone="muted">Share an invitation so they can join on their own device. Only people with the link can use it.</Copy>
    <View style={[styles.row, { flexWrap: "wrap", gap: 12 }]}>
      {([{ label: "Maximum uses", value: maxUses, change: setMaxUses, hint: "1–100 people" },
        { label: "Expires after (days)", value: days, change: setDays, hint: "1–365 days" }] as const).map(field =>
        <View key={field.label} style={{ flexGrow: 1, flexBasis: 160, gap: 6 }}><Copy tone="label">{field.label}</Copy>
          <TextInput testID={field.label} accessibilityLabel={field.label} value={field.value} onChangeText={field.change} keyboardType="number-pad"
            maxLength={3} editable={!state.busy} style={{ minHeight: 50, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, color: colors.text, backgroundColor: colors.background, fontSize: 16 }} />
          <Copy tone="muted">{field.hint}</Copy></View>)}
    </View>
    <Action secondary disabled={disabled || !validInvitationLimits(Number(maxUses), Number(days))} label="Create invitation"
      onPress={() => { setFeedback(null); void controller.create(Number(maxUses), Number(days)) }} />
    {state.error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{state.error}</Copy></View> : null}
    {state.message || feedback ? <View accessibilityLiveRegion="polite"><Copy>{feedback ?? state.message}</Copy></View> : null}
    <Copy tone="heading">Your invitation links</Copy>
    {!available ? <Copy tone="muted">Connect and unlock parent access to manage invitation links.</Copy>
      : state.busy ? <Copy tone="muted">Updating invitations…</Copy>
      : state.ready && !state.page?.items.length ? <Copy tone="muted">No invitation links yet.</Copy> : null}
    {state.page?.items.map(invite => <View key={invite.id} style={{ gap: 10, borderTopWidth: 1, borderColor: colors.border, paddingTop: 14 }}>
      <Copy tone="label">Invitation code: {invite.code}</Copy>
      <Copy tone="muted">{invite.usesCount} of {invite.maxUses} uses · Expires {new Date(invite.expiresAt).toLocaleDateString()}</Copy>
      {invite.status !== "available" ? <Copy tone="muted">{invite.status === "expired" ? "Expired" : "All uses taken"}</Copy> :
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          <Action secondary disabled={disabled} label="Copy link" accessibilityLabel={`Copy invitation ${invite.code}`} onPress={() => void share(invite.code, true)} />
          <Action secondary disabled={disabled} label="Share link" accessibilityLabel={`Share invitation ${invite.code}`} onPress={() => void share(invite.code, false)} />
        </View>}
      <Action secondary disabled={disabled} label="Revoke link" accessibilityLabel={`Revoke invitation ${invite.code}`} onPress={() => { const confirm = controller.prepareRevocation(invite.id); Alert.alert("Revoke this invitation?",
        "This link will stop working. Existing household members will keep their access.", [
          { text: "Cancel", style: "cancel" }, { text: "Revoke invitation", style: "destructive", onPress: () => { setFeedback(null); void confirm() } },
        ]) }} />
    </View>)}
    <Action secondary disabled={!available || state.busy} label="Refresh invitations" onPress={() => { setFeedback(null); void controller.refresh() }} />
    {state.page?.nextCursor ? <Action secondary disabled={disabled} label="Load older invitations" onPress={() => void controller.refresh(true)} /> : null}
  </Card>
}
