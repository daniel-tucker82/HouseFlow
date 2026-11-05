import { useCallback, useRef, useState } from "react"
import { useFocusEffect, router } from "expo-router"
import { Alert, Switch, View } from "react-native"
import type { HouseholdDeletionReceipt } from "../../../shared/mobile/household-deletion"
import { useBoard, useRuntime } from "../providers/runtime"
import { Action, Card, Copy, styles, usePalette } from "./ui"

export function HouseholdDeletionCard() {
  const { api, controller, syncPaused } = useRuntime(), board = useBoard(), colors = usePalette()
  const [receipts, setReceipts] = useState<HouseholdDeletionReceipt[]>([]), [error, setError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false)
  const generation = useRef(0), revision = useRef(0), active = useRef(false), saving = useRef(false)
  const available = board.online && !syncPaused, household = board.board?.household
  const canDelete = household?.role === "manager" && household.leaderId === controller.accountId
  const load = useCallback(async () => {
    if (!active.current || saving.current) return
    const current = generation.current, read = ++revision.current
    setBusy(true); setError(null)
    try { const rows = await api.householdDeletions(); if (active.current && generation.current === current && revision.current === read) setReceipts(rows) }
    catch (cause) { if (active.current && generation.current === current && revision.current === read) { setReceipts([]); setError(cause instanceof Error ? cause.message : "Unable to check deletion.") } }
    finally { if (active.current && generation.current === current && revision.current === read) setBusy(false) }
  }, [api])
  useFocusEffect(useCallback(() => {
    active.current = available; generation.current++; setAcknowledged(false); setReceipts([])
    if (available) void load()
    return () => { active.current = false; generation.current++ }
  }, [available, load]))
  async function remove(confirmationGeneration: number) {
    if (!active.current || generation.current !== confirmationGeneration || saving.current || !canDelete || !household || !acknowledged) return
    const current = generation.current
    revision.current++
    saving.current = true; setBusy(true); setError(null)
    try {
      await api.deleteHousehold(household.id)
      await controller.refresh()
      if (active.current && generation.current === current) {
        const rows = await api.householdDeletions()
        if (active.current && generation.current === current) { setAcknowledged(false); setReceipts(rows) }
      }
    } catch (cause) {
      if (active.current && generation.current === current) setError(cause instanceof Error ? cause.message : "Unable to confirm deletion. Refresh before trying again.")
      // A lost response may follow a committed deletion. Never automatically submit again.
      await controller.refresh().catch(() => {})
    } finally {
      saving.current = false
      if (active.current) { setBusy(false); if (generation.current !== current) void load() }
    }
  }
  return <Card><Copy tone="heading">Household deletion</Copy>
    {canDelete ? <>
      <Copy>Delete {household.name}, including its routines, tasks and memberships. Your account and other households will stay. This cannot be undone.</Copy>
      <Copy tone="muted">Website subscription cancellation finishes in the background. Apple and Google Play subscriptions must be cancelled separately in the store to stop future charges. Purchases cannot be moved to another household.</Copy>
      <Action secondary label="Manage subscriptions first" disabled={!available || busy} onPress={() => router.navigate("/settings")} />
      <View style={[styles.row, { alignItems: "flex-start" }]}><Switch accessibilityLabel="I understand household deletion and subscription cancellation" value={acknowledged}
        disabled={!available || busy} onValueChange={setAcknowledged} trackColor={{ true: colors.primary }} />
        <Copy style={{ flex: 1 }}>I understand the permanent deletion and the separate store cancellation requirements.</Copy></View>
      <Action secondary label="Delete this household" disabled={!available || busy || !acknowledged} onPress={() => { const confirmationGeneration = generation.current; Alert.alert(`Delete ${household.name}?`,
        "This permanently deletes the household for everyone. Apple and Google Play subscriptions still need to be cancelled separately.", [
          { text: "Keep household", style: "cancel" }, { text: "Delete household", style: "destructive", onPress: () => void remove(confirmationGeneration) },
        ]) }} />
    </> : null}
    {!available ? <Copy tone="muted">Connect and unlock parent access to check household deletion.</Copy> : null}
    {error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{error}</Copy></View> : null}
    {receipts.map(receipt => <View key={receipt.id} style={{ gap: 6 }}>
      <Copy tone="label">Household deleted · {new Date(receipt.createdAt).toLocaleDateString()}</Copy>
      <Copy tone="muted">{receipt.state === "pending" ? "Website subscription cancellation is saved and still processing. You can close the app; it will continue in the background."
        : "Household data deletion and any website billing cleanup are complete. This does not confirm Apple or Google Play cancellation."}</Copy>
    </View>)}
    <Action secondary label={busy ? "Checking deletion…" : "Refresh deletion status"} disabled={!available || busy} onPress={() => void load()} />
  </Card>
}
