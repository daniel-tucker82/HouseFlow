import { useState } from "react"
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Share, TextInput, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Action, Card, Copy, styles, usePalette } from "../components/ui"
import { useBoard, useRuntime } from "../providers/runtime"

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  const colors = usePalette()
  return <View style={{ gap: 6 }}><Copy tone="label">{label}</Copy><TextInput accessibilityLabel={label} value={value} onChangeText={onChange}
    placeholder={placeholder} placeholderTextColor={colors.muted} maxLength={150} style={{ color: colors.text, backgroundColor: colors.background,
      borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14, minHeight: 50, fontSize: 16 }} /></View>
}

export default function HouseholdScreen() {
  const { api, controller } = useRuntime()
  const state = useBoard()
  const colors = usePalette()
  const [name, setName] = useState("")
  const [childName, setChildName] = useState("")
  const [invitation, setInvitation] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inviteCode, setInviteCode] = useState<string | null>(null)
  const household = state.board?.household
  const manager = household?.role === "manager"
  const disabled = busy || !state.online

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(null)
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save. Please try again.") }
    finally { setBusy(false) }
  }

  async function flow(action: string, values: Record<string, unknown>) {
    await api.request("/api/leader/flow", { action, householdId: household?.id, ...values })
    await controller.refresh()
  }

  return <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: colors.background }}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Copy tone="title">{household?.name ?? "Your household"}</Copy>
        {!state.online ? <Copy tone="muted">Connect to manage your household. Saved tasks are still available in Today.</Copy> : null}
        {error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{error}</Copy></View> : null}
        {household ? <Card><Copy tone="heading">Everyone at home</Copy>
          {state.board?.members.map(member => <View key={member.id} style={{ gap: 10, paddingVertical: 12, borderTopWidth: 1, borderColor: colors.border }}>
            <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}><Copy style={{ fontWeight: "600" }}>{member.name}</Copy><Copy tone="muted">{member.role === "manager" ? "Household owner" : member.role === "supervisor" ? "Supervisor" : "Member"}</Copy></View>
            {manager && member.id !== household.leaderId ? <View style={{ gap: 8 }}>
              <Action secondary disabled={disabled} label={member.role === "supervisor" ? "Make a member" : "Make a supervisor"} onPress={() => Alert.alert("Change household role?",
                member.role === "supervisor" ? `${member.name} will be able to update their own tasks.` : `${member.name} will be able to manage routines and tasks for the household.`, [
                  { text: "Cancel", style: "cancel" }, { text: "Change role", onPress: () => void act(() => flow("updateMemberRole", { memberUserId: member.id, role: member.role === "supervisor" ? "member" : "supervisor" })) },
                ])} />
              <Action secondary disabled={disabled} label={`Remove ${member.name}`} onPress={() => Alert.alert(`Remove ${member.name}?`, "They will lose access to this household.", [
                { text: "Cancel", style: "cancel" }, { text: "Remove", style: "destructive", onPress: () => void act(() => flow("removeHouseholdMember", { memberUserId: member.id })) },
              ])} />
            </View> : null}
          </View>)}
        </Card> : null}
        {manager ? <>
          <Card><Copy tone="heading">Add a child or family member</Copy><Copy tone="muted">No email address needed. They can use your device or the family tablet.</Copy>
            <Field label="Their name" value={childName} onChange={setChildName} placeholder="First name" />
            <Action disabled={disabled || !childName.trim()} label={busy ? "Saving…" : "Add member"} onPress={() => void act(async () => {
              await flow("createHouseholdMember", { name: childName.trim(), role: "member" }); setChildName("")
            })} />
          </Card>
          <Card><Copy tone="heading">Invite someone with an account</Copy><Copy tone="muted">Share an invitation so they can join on their own device.</Copy>
            <Action secondary disabled={disabled} label="Create invitation" onPress={() => void act(async () => {
              const result = await api.request<{ invite: { code: string } }>("/api/leader/flow", { action: "createInvite", householdId: household?.id, maxUses: 10, expiresInDays: 30 })
              setInviteCode(result.invite.code)
            })} />
            {inviteCode ? <><Copy>Invitation code: {inviteCode}</Copy><Copy tone="muted">Valid for 30 days, for up to 10 people.</Copy><Action label="Share invitation" onPress={() => void Share.share({ message: `Join our household on Cyntch: https://www.cyntch.com/join/${inviteCode}` }).catch(cause => setError(cause.message))} /></> : null}
          </Card>
        </> : null}
        <Card><Copy tone="heading">Create a household</Copy><Copy tone="muted">Give your household a name everyone recognises.</Copy>
          <Field label="Household name" value={name} onChange={setName} placeholder="Our family" />
          <Action disabled={disabled || name.trim().length < 2} label={busy ? "Saving…" : "Create household"} onPress={() => void act(async () => {
            const result = await api.request<{ household: { id: string } }>("/api/leader/flow", { action: "createHousehold", name: name.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
            await controller.selectHousehold(result.household.id); setName("")
          })} />
        </Card>
        <Card><Copy tone="heading">Join a household</Copy><Field label="Invitation code or link" value={invitation} onChange={setInvitation} placeholder="Paste your invitation" />
          <Action secondary disabled={disabled || !invitation.trim()} label="Join household" onPress={() => void act(async () => {
            let code = invitation.trim()
            if (code.startsWith("https://") || code.startsWith("http://")) {
              const link = new URL(code)
              if (!["www.cyntch.com", "cyntch.com"].includes(link.hostname) || !link.pathname.startsWith("/join/")) throw new Error("Use a Cyntch invitation link or code.")
              code = link.pathname.split("/")[2]
            }
            const result = await api.request<{ householdId: string }>("/api/mobile/join", { code })
            await controller.selectHousehold(result.householdId); setInvitation("")
          })} />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>
}
