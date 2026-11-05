import { useRef, useState } from "react"
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { buildNativeMemberColorMap, NATIVE_TOKEN_COLOR_OPTIONS } from "../../../shared/member-tokens"
import { Action, Card, Copy, styles, usePalette } from "../components/ui"
import { useBoard, useRuntime } from "../providers/runtime"
import { HouseholdInvitations } from "../components/household-invitations"
import { HouseholdDeletionCard } from "../components/household-deletion"

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  const colors = usePalette()
  return <View style={{ gap: 6 }}><Copy tone="label">{label}</Copy><TextInput testID={label} accessibilityLabel={label} value={value} onChangeText={onChange}
    placeholder={placeholder} placeholderTextColor={colors.muted} maxLength={150} style={{ color: colors.text, backgroundColor: colors.background,
      borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14, minHeight: 50, fontSize: 16 }} /></View>
}

export default function HouseholdScreen() {
  const state = useBoard(), { controller } = useRuntime()
  // Drafts and invitation codes belong to one account, household and role.
  return <HouseholdWorkspace key={`${controller.accountId}:${state.board?.household.id}:${state.board?.household.role}`} />
}

function HouseholdWorkspace() {
  const { api, controller, syncPaused } = useRuntime()
  const state = useBoard()
  const colors = usePalette()
  const [name, setName] = useState("")
  const [childName, setChildName] = useState("")
  const [invitation, setInvitation] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null)
  const [colorMemberId, setColorMemberId] = useState<string | null>(null)
  const saving = useRef(false)
  const household = state.board?.household
  const manager = household?.role === "manager"
  const management = manager || household?.role === "supervisor"
  const memberColors = buildNativeMemberColorMap(state.board?.members ?? [])
  const disabled = busy || !state.online || syncPaused

  async function act(work: () => Promise<void>) {
    if (saving.current || !state.online || syncPaused) return
    saving.current = true
    setBusy(true); setError(null)
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save. Please try again.") }
    finally { saving.current = false; setBusy(false) }
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
            <View style={[styles.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
              <View style={[styles.row, { flexShrink: 1 }]}><View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: memberColors.get(member.id)?.background, borderWidth: 1, borderColor: colors.muted }} /><Copy style={{ fontWeight: "600", flexShrink: 1 }}>{member.name}</Copy></View>
              <Copy tone="muted">{member.role === "manager" ? "Household owner" : member.role === "supervisor" ? "Supervisor" : "Member"}</Copy>
            </View>
            {manager && member.is_clerk_linked === false ? rename?.id === member.id ? <View style={{ gap: 8 }}>
              <Field label={`Name for ${member.name}`} value={rename.name} onChange={name => setRename({ id: member.id, name })} />
              <Action disabled={disabled || !rename.name.trim() || rename.name.trim() === member.name} label="Save name" onPress={() => void act(async () => {
                await flow("renameHouseholdMember", { memberUserId: member.id, name: rename.name.trim() }); setRename(null)
              })} />
              <Action secondary disabled={busy} label="Cancel name change" onPress={() => setRename(null)} />
            </View> : <Action secondary disabled={disabled} label={`Rename ${member.name}`} onPress={() => { setRename({ id: member.id, name: member.name }); setColorMemberId(null) }} /> : null}
            {management ? colorMemberId === member.id ? <View style={{ gap: 10 }}>
              <Copy tone="label">Colour for {member.name}</Copy>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {NATIVE_TOKEN_COLOR_OPTIONS.map(option => <Pressable key={option.id} accessibilityRole="button"
                  accessibilityLabel={`${member.name}: ${option.label} colour`} accessibilityState={{ selected: member.token_color === option.id, disabled }} disabled={disabled}
                  onPress={() => void act(async () => { await flow("updateMemberTokenColor", { memberUserId: member.id, tokenColor: option.id }); setColorMemberId(null) })}
                  style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, minWidth: 110, padding: 12, borderRadius: 12,
                    borderWidth: member.token_color === option.id ? 2 : 1, borderColor: member.token_color === option.id ? colors.primary : colors.border,
                    backgroundColor: colors.surface, opacity: disabled ? 0.5 : pressed ? 0.75 : 1 })}>
                  <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: option.background, borderWidth: 1, borderColor: option.foreground }} />
                  <Copy>{option.label}{member.token_color === option.id ? " ✓" : ""}</Copy>
                </Pressable>)}
              </View>
              <Action secondary disabled={disabled} selected={!member.token_color} label="Use automatic colour" onPress={() => void act(async () => {
                await flow("updateMemberTokenColor", { memberUserId: member.id, tokenColor: null }); setColorMemberId(null)
              })} />
              <Action secondary disabled={busy} label="Cancel colour change" onPress={() => setColorMemberId(null)} />
            </View> : <Action secondary disabled={disabled} label={`Change colour for ${member.name}`} onPress={() => { setColorMemberId(member.id); setRename(null) }} /> : null}
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
          <HouseholdInvitations householdId={household.id} online={state.online} />
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
        <HouseholdDeletionCard />
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>
}
