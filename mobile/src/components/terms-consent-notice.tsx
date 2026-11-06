import { useEffect, useRef, useState } from "react"
import { ScrollView, Switch, View } from "react-native"
import { openURL } from "expo-linking"
import { SafeAreaView } from "react-native-safe-area-context"
import type { TermsStatus } from "../../../shared/terms-consent"
import { useBoard, useRuntime } from "../providers/runtime"
import { Action, Copy, styles, usePalette } from "./ui"
import { AppModal } from "./app-modal"

/** Background discovery never holds up local task saving or board startup. */
export function TermsConsentNotice() {
  const { api, syncPaused } = useRuntime(), { online } = useBoard(), colors = usePalette()
  const [status, setStatus] = useState<TermsStatus | null>(null)
  const [open, setOpen] = useState(false), [agreed, setAgreed] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null), live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    if (!online || syncPaused) return
    let cancelled = false, checking = false
    const refresh = () => {
      if (checking) return
      checking = true
      void api.termsStatus().then(value => { if (!cancelled) { setStatus(value); setAgreed(false); if (value.required && !value.acceptedAt) setOpen(true) } })
        .catch(() => undefined).finally(() => { checking = false })
    }
    const unsubscribe = api.subscribeTermsRequired(refresh)
    refresh()
    return () => { cancelled = true; unsubscribe() }
  }, [api, online, syncPaused])
  if (syncPaused || !status?.required || status.acceptedAt) return null
  async function accept() {
    if (!status || !agreed || saving || !online) return
    setSaving(true); setError(null)
    try {
      const result = await api.acceptTerms(status.version)
      if (live.current) { setStatus(result); setAgreed(false); setOpen(false) }
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : "Your agreement could not be confirmed. Retry when connected.") }
    finally { if (live.current) setSaving(false) }
  }
  return <SafeAreaView edges={["top", "left", "right"]} style={{ backgroundColor: colors.soft }}>
    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}><Action secondary label="Review terms before creating content" onPress={() => setOpen(true)} /></View>
    <AppModal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><ScrollView contentContainerStyle={styles.content}>
        <Copy tone="heading">Before sharing with your household</Copy>
        <Copy>Read Cyntch’s Terms of use before creating or editing household content. Keep tasks and routines appropriate for your family and respect other people’s privacy.</Copy>
        <Copy tone="muted">Do not share sexual, exploitative, threatening, hateful or abusive content. Report a concern through Settings or the contact listed in the terms.</Copy>
        <Action secondary label="Read Terms of use" onPress={() => void openURL(status.url).catch(() => setError("The terms could not be opened. Check your connection and try again."))} />
        <View style={styles.row}><Switch accessibilityLabel="I have read and agree to the Terms of use" value={agreed} onValueChange={setAgreed} disabled={saving} trackColor={{ true: colors.primary }} />
          <View style={{ flex: 1 }}><Copy>I have read and agree to the Terms of use.</Copy></View></View>
        <Copy tone="muted">Version {status.version}. Your agreement applies to this Cyntch account on all devices.</Copy>
        {!online ? <Copy tone="muted">Connect to confirm your agreement. You can still view your saved household and update task completion.</Copy> : null}
        {error ? <Copy style={{ color: colors.danger }}>{error}</Copy> : null}
        <Action label={saving ? "Confirming agreement…" : "Accept and continue"} disabled={!agreed || saving || !online} onPress={() => void accept()} />
        <Action secondary label="Continue without creating content" onPress={() => setOpen(false)} />
      </ScrollView></SafeAreaView>
    </AppModal>
  </SafeAreaView>
}
