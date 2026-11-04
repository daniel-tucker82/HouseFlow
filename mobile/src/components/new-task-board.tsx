import { useEffect, useRef, useState, type ReactNode } from "react"
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native"
import { AppModal } from "./app-modal"
import { SafeAreaView } from "react-native-safe-area-context"
import { usePlanner, useRuntime } from "../providers/runtime"
import { PlannerPendingCreations } from "./planner-pending-creations"
import { Action, Copy, styles, usePalette } from "./ui"

/** The name is a local draft; submission waits only for its durable queue write. */
export function NewTaskBoard({ householdId, enabled, children }: { householdId: string; enabled: boolean; children: (controls: ReactNode) => ReactNode }) {
  const { planner, controller, store } = useRuntime(), state = usePlanner(), colors = usePalette()
  const [open, setOpen] = useState(false), [title, setTitle] = useState("")
  const [loaded, setLoaded] = useState(false), [saving, setSaving] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const mounted = useRef(true), draftRevision = useRef(0), submitting = useRef(false)
  const pending = state.creations.some(item => item.householdId === householdId && item.body.action === "createTaskBoard")
  useEffect(() => {
    let cancelled = false
    mounted.current = true
    void store.planner.boardDraft(controller.accountId, householdId).then(value => {
      if (!cancelled) { setTitle(value); setLoaded(true); setError(null) }
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to open your saved name.") })
    return () => { cancelled = true; mounted.current = false }
  }, [store, controller.accountId, householdId, loadAttempt])
  function change(value: string) {
    const revision = ++draftRevision.current
    setTitle(value); setSaving(true); setError(null)
    void store.planner.saveBoardDraft(controller.accountId, householdId, value).then(() => {
      if (mounted.current && revision === draftRevision.current) setSaving(false)
    }).catch(reason => {
      if (mounted.current && revision === draftRevision.current) {
        setSaving(false); setError(`Name not saved on this device. ${reason instanceof Error ? reason.message : "Please try again."}`)
      }
    })
  }
  async function submit() {
    if (submitting.current) return
    submitting.current = true; setBusy(true); setError(null)
    try {
      if (planner.getSnapshot().household?.id !== householdId) throw new Error("Reopen this household before creating a board.")
      await store.planner.saveBoardDraft(controller.accountId, householdId, title)
      await planner.create("createTaskBoard", { title }, `New task board: ${title.trim()}`)
      if (mounted.current) { setTitle(""); setOpen(false); setSaving(false) }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Unable to save this task board.") }
    finally { submitting.current = false; if (mounted.current) setBusy(false) }
  }
  // Keep the sheet outside the list's column-count key. Rotation may remount
  // the virtualized list without closing or resetting this unfinished form.
  return <>{children(enabled ? <View style={{ gap: 12 }}>
    <Action secondary label={title ? "Continue new task board" : "New task board"} disabled={!loaded || pending || state.busy} onPress={() => setOpen(true)} />
    {!open && error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{error}</Copy></View> : null}
    {!loaded && error ? <Action secondary label="Reload saved board name" onPress={() => { setError(null); setLoadAttempt(value => value + 1) }} /> : null}
    <PlannerPendingCreations householdId={householdId} onlyBoards />
    </View> : null)}
    <AppModal visible={enabled && open} animationType="slide" presentationStyle="pageSheet" supportedOrientations={["portrait", "landscape-left", "landscape-right"]} onRequestClose={() => { if (!busy) setOpen(false) }}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={[styles.content, { maxWidth: 800, gap: 16 }]}>
            <Copy tone="title">New task board</Copy>
            <Copy tone="muted">Give your one-off tasks a place of their own. Creating a board requires Premium.</Copy>
            <Copy tone="label">Board name</Copy>
            <TextInput accessibilityLabel="New task board name" value={title} onChangeText={change} editable={!busy} maxLength={200}
              placeholder="For example, Saturday jobs" placeholderTextColor={colors.muted} autoFocus returnKeyType="done" disableFullscreenUI
              onSubmitEditing={() => { if (state.online && title.trim() && !state.busy) void submit() }}
              style={{ minHeight: 52, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, fontSize: 16, color: colors.text, backgroundColor: colors.surface }} />
            {error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{error}</Copy></View>
              : <Copy tone="muted">{saving ? "Saving name on this device…" : title ? "Name saved on this device. You can finish later." : ""}</Copy>}
            {!state.online ? <Copy tone="muted">Connect to create this board. You can keep editing its name offline.</Copy> : null}
            <Action label={busy ? "Saving request…" : "Create task board"} disabled={!state.online || state.busy || busy || !title.trim()} onPress={() => void submit()} />
            <Action secondary label="Finish later" disabled={busy} onPress={() => setOpen(false)} />
            {title ? <Action secondary label="Clear name" disabled={busy} onPress={() => change("")} /> : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </AppModal>
  </>
}
