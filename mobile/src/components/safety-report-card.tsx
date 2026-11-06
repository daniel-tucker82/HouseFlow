import { useEffect, useState, useSyncExternalStore } from "react"
import { Alert, ScrollView, TextInput, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { useBoard, useRuntime } from "../providers/runtime"
import { AppModal } from "./app-modal"
import { Action, Card, Copy, styles, usePalette } from "./ui"
import type { SafetyReportKind } from "../../../shared/mobile/safety-reports"

const kinds: { value: SafetyReportKind; label: string }[] = [{ value: "content", label: "Content" }, { value: "member", label: "A household member" }, { value: "other", label: "Something else" }]
export function SafetyReportCard() {
  const { safetyReports } = useRuntime()
  const report = useSyncExternalStore(safetyReports.subscribe, safetyReports.getSnapshot, safetyReports.getSnapshot)
  const board = useBoard()
  const colors = usePalette()
  const [open, setOpen] = useState(false)
  useEffect(() => { if (board.online) void safetyReports.checkAvailability() }, [board.online, safetyReports])
  const draft = report.draft
  function showError(error: unknown) { Alert.alert("Report not saved", error instanceof Error ? error.message : "Please try again.") }
  function edit(patch: Parameters<typeof safetyReports.edit>[0]) { void safetyReports.edit(patch).catch(() => undefined) }
  const household = board.households.find(item => item.id === draft?.householdId)
  const inputStyle = { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, fontSize: 16, color: colors.text, backgroundColor: colors.background, minHeight: 48 }
  return <Card>
    <Copy tone="heading">Report a concern</Copy>
    <Copy tone="muted">Tell Cyntch about harmful content or behaviour in your household. Reports are private to Cyntch support.</Copy>
    {report.receipt ? <Copy>Report received. Reference: {report.receipt.id}</Copy> : null}
    {report.error ? <Copy style={{ color: colors.warning }}>{report.error}</Copy> : null}
    {!report.available && !draft ? <Copy tone="muted">{board.online ? "In-app reporting is not available on this service yet." : "Connect to check reporting availability."}</Copy> : null}
    <Action secondary label={draft ? "Open saved report" : "Report content or a member"} disabled={!report.ready || (!draft && (!report.available || !board.board))}
      onPress={() => { setOpen(true); if (!draft && board.board) void safetyReports.begin(board.board.household.id).catch(showError) }} />
    <AppModal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Copy tone="heading">Report a concern</Copy>
          <Copy tone="muted">Reports go to Cyntch support, not to other household members. Include only details needed to understand the concern. This is not an emergency service.</Copy>
          {draft ? <>
            <Copy tone="label">Household: {household?.name ?? "Saved household"}</Copy>
            <View style={{ gap: 8 }}>{kinds.map(kind => <Action key={kind.value} secondary label={kind.label} selected={draft.kind === kind.value} disabled={report.pending} onPress={() => edit({ kind: kind.value })} />)}</View>
            <Copy tone="label">Which content or person?</Copy>
            <TextInput accessibilityLabel="Content or person to report" value={draft.subject} onChangeText={subject => edit({ subject })} editable={!report.pending} maxLength={200} style={inputStyle} />
            <Copy tone="label">Describe your concern</Copy>
            <TextInput accessibilityLabel="Describe your concern" value={draft.message} onChangeText={message => edit({ message })} editable={!report.pending} multiline maxLength={2000} style={[inputStyle, { minHeight: 144, textAlignVertical: "top" }]} />
            <Copy tone="muted">{report.saving ? "Saving on this device…" : !report.saved ? "Not saved yet. Keep this screen open." : report.pending ? "Saved on this device. Waiting for confirmation from Cyntch." : "Draft saved on this device. It has not been sent."}</Copy>
            {!board.online ? <Copy tone="muted">You are offline. A submitted report will be sent when Cyntch is open and connected.</Copy> : null}
            {report.error ? <Copy style={{ color: colors.warning }}>{report.error}</Copy> : null}
            <Action label={report.sending ? "Sending report…" : report.pending ? "Retry saved report" : "Submit report"} disabled={report.sending || (report.pending && !board.online)}
              onPress={() => { if (report.pending) void safetyReports.flush(); else void safetyReports.submit().catch(showError) }} />
            {!report.pending ? <Action secondary label="Discard draft" disabled={report.saving > 0} onPress={() => Alert.alert("Discard this report draft?", "It has not been sent to Cyntch.", [
              { text: "Keep draft", style: "cancel" }, { text: "Discard draft", style: "destructive", onPress: () => void safetyReports.discard().then(() => setOpen(false)).catch(showError) },
            ])} /> : null}
          </> : report.receipt ? <Copy>Report received. Keep this reference if you contact Cyntch: {report.receipt.id}</Copy> : null}
          <Action secondary label="Close report" onPress={() => setOpen(false)} />
        </ScrollView>
      </SafeAreaView>
    </AppModal>
  </Card>
}
