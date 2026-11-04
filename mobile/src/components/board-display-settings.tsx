import { useState } from "react"
import { ScrollView, Switch, View } from "react-native"
import { AppModal } from "./app-modal"
import { SafeAreaView } from "react-native-safe-area-context"
import type { BoardSnapshot } from "../../../shared/mobile/contracts"
import { boardDisplayAccess, defaultBoardDisplay, type BoardDisplayPreferences } from "../../../shared/mobile/board-view"
import { Action, Card, Copy, styles, usePalette } from "./ui"

export function BoardDisplaySettings({ board, accountId, preferences, onSave, onClose }: {
  board: BoardSnapshot; accountId: string; preferences: BoardDisplayPreferences;
  onSave: (preferences: BoardDisplayPreferences) => Promise<void>; onClose: () => void
}) {
  const colors = usePalette(), [draft, setDraft] = useState(preferences)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const access = boardDisplayAccess(board, draft, accountId)
  function change(id: string, field: "visible" | "editable", enabled: boolean) {
    setError(null)
    const visible = field === "visible" ? enabled ? [...access.visibleMemberIds, id] : access.visibleMemberIds.filter(item => item !== id) : access.visibleMemberIds
    const editable = field === "editable" ? enabled ? [...access.editableMemberIds, id] : access.editableMemberIds.filter(item => item !== id) : access.editableMemberIds
    setDraft({ version: 1, visibleMemberIds: visible, editableMemberIds: editable.filter(item => visible.includes(item)) })
  }
  async function save() {
    setBusy(true); setError(null)
    try { await onSave(draft); onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "These display settings could not be saved.") }
    finally { setBusy(false) }
  }
  return <AppModal visible animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape-left", "landscape-right"]} onRequestClose={() => { if (!busy) onClose() }}>
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={[styles.content, { maxWidth: 750 }]}>
        <Copy tone="heading">Display settings</Copy>
        <Copy>Choose whose tasks appear in {board.household.name} on this device, and whose tasks can be updated here.</Copy>
        <Copy tone="muted">Use kiosk mode in Settings to protect the display from changes to parental controls.</Copy>
        {board.members.map(member => {
          const visible = access.visibleMemberIds.includes(member.id)
          return <Card key={member.id}><Copy tone="heading">{member.name}</Copy>
            {member.id === board.household.leaderId ? <Copy tone="muted">Includes unassigned tasks.</Copy> : null}
            <View style={styles.row}><Copy style={{ flex: 1 }}>Show tasks</Copy><Switch accessibilityLabel={`Show tasks for ${member.name}`} value={visible} disabled={busy} onValueChange={enabled => change(member.id, "visible", enabled)} /></View>
            <View style={styles.row}><Copy style={{ flex: 1 }}>Allow task updates</Copy><Switch accessibilityLabel={`Allow task updates for ${member.name}`} value={access.editableMemberIds.includes(member.id)} disabled={busy || !visible} onValueChange={enabled => change(member.id, "editable", enabled)} /></View>
          </Card>
        })}
        {!access.visibleMemberIds.length ? <Copy style={{ color: colors.warning }}>Choose at least one household member.</Copy> : null}
        {error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{error}</Copy></View> : null}
        <Action label={busy ? "Saving display…" : "Save display"} disabled={busy || !access.visibleMemberIds.length} onPress={() => void save()} />
        <Action secondary label="Show and allow updates for everyone" disabled={busy} onPress={() => { setError(null); setDraft(defaultBoardDisplay()) }} />
        <Action secondary label="Cancel" disabled={busy} onPress={onClose} />
      </ScrollView>
    </SafeAreaView>
  </AppModal>
}
