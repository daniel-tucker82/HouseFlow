import { useAuth } from "@clerk/expo"
import { randomUUID } from "expo-crypto"
import { useRouter } from "expo-router"
import { useEffect, useState } from "react"
import { Alert, Pressable, ScrollView, Switch, useWindowDimensions, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import type { AccountDeletionOwnershipChoice, AccountDeletionReview, AccountDeletionSubmission } from "../../../shared/mobile/account-deletion"
import { Action, Card, Copy, styles, usePalette } from "../components/ui"
import { AccountDeletionStatusView } from "../components/account-deletion-status"
import { useRuntime, useBoard } from "../providers/runtime"
import { useAccountDeletionRecovery } from "../providers/account-deletion-recovery"
import { useAccountDeletionActions } from "../providers/account-deletion-actions"

const quantity = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
function Choice({label,selected,disabled,onPress}: {label:string;selected:boolean;disabled:boolean;onPress:()=>void}) {
  const colors = usePalette()
  return <Pressable accessibilityRole="radio" accessibilityState={{checked:selected,disabled}} disabled={disabled} onPress={onPress}
    style={{minHeight:52,padding:14,borderRadius:12,borderWidth:2,borderColor:selected ? colors.primary : colors.border,backgroundColor:selected ? colors.soft : colors.surface}}>
    <Copy>{selected ? "● " : "○ "}{label}</Copy>
  </Pressable>
}

export default function AccountDeletionScreen() {
  const {api,store,syncPaused} = useRuntime(), board = useBoard(), router = useRouter(), colors = usePalette(), {width} = useWindowDimensions()
  const {userId,sessionId} = useAuth({treatPendingAsSignedOut:false}), recovery = useAccountDeletionRecovery(), actions = useAccountDeletionActions()
  const [review,setReview] = useState<AccountDeletionReview | null>(null), [saved,setSaved] = useState<AccountDeletionSubmission | null>(null)
  const [choices,setChoices] = useState<Record<string,AccountDeletionOwnershipChoice>>({}), [accountConsent,setAccountConsent] = useState(false), [billingConsent,setBillingConsent] = useState(false)
  const [error,setError] = useState<string | null>(null), [loading,setLoading] = useState(true), [attempt,setAttempt] = useState(0)
  const [showSaved,setShowSaved] = useState(false)
  const requestId = recovery.state.record?.requestId ?? null
  const [loadedRequestId,setLoadedRequestId] = useState<string | null>(null)
  const reviewLoading = loading || loadedRequestId !== requestId
  useEffect(() => {
    let cancelled = false
    void Promise.all([api.accountDeletionReview(),store.accountDeletion.read()]).then(([result,intent]) => {
      if (cancelled) return
      const matching = intent?.submission.accountId === result.accountId && intent.submission.intent.operationId === requestId ? intent.submission : null
      setReview(result);setSaved(matching)
      setChoices(matching ? Object.fromEntries(matching.intent.ownership.map(choice => [choice.householdId,choice])) : {})
      setAccountConsent(Boolean(matching));setBillingConsent(Boolean(matching));setError(null)
    }).catch(cause => {if (!cancelled) {setReview(null);setSaved(null);setError(cause instanceof Error ? cause.message : "Unable to review deletion. Please try again.")}}).finally(() => {if (!cancelled) {setLoadedRequestId(requestId);setLoading(false)}})
    return () => {cancelled = true}
  },[api,store,attempt,requestId])
  const record = recovery.state.record, owned = review?.households.filter(household => household.owned) ?? []
  const changed = saved && (saved.accountId !== userId || saved.sessionId !== sessionId || saved.intent.revision !== review?.revision)
  const occupied = record && record.accountId !== userId
  const frozen = Boolean(record), working = actions.busy || recovery.state.busy || reviewLoading
  const canSubmit = Boolean(review && !occupied && !changed && (!record || saved) && !record?.submitted && accountConsent && billingConsent && owned.every(household => choices[household.id]) && board.online && !syncPaused && !working)
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : "Your saved request has been kept. Please try again.")
  function confirm() {
    if (!review || !canSubmit) return
    Alert.alert("Delete your Cyntch account?","This permanently removes your account and the content described in this review. Household ownership choices take effect when the request is accepted. An accepted request cannot be cancelled.",[
      {text:"Keep account",style:"cancel"},{text:"Delete account",style:"destructive",onPress:() => {
        const submission = saved ?? {accountId:review.accountId,sessionId:review.sessionId,deviceId:review.deviceId,origin:new URL(process.env.EXPO_PUBLIC_API_URL ?? "https://www.cyntch.com").origin,
          intent:{operationId:randomUUID(),revision:review.revision,ownership:Object.values(choices),confirmAccountDeletion:true as const,acknowledgeSubscriptions:true as const}}
        void actions.submit(submission).catch(report)
      }},
    ])
  }
  if (showSaved) return <AccountDeletionStatusView onClose={() => setShowSaved(false)} onReview={() => setShowSaved(false)} />
  return <SafeAreaView edges={["top","left","right"]} style={{flex:1,backgroundColor:colors.background}}><ScrollView contentContainerStyle={styles.content}>
    <Action secondary label="Back to settings" disabled={actions.busy} onPress={() => router.replace("/settings")} />
    <Copy tone="title">Delete your account</Copy><Copy tone="muted">Review what will happen to your households, content and subscriptions before continuing.</Copy>
    {error ? <Card><View accessibilityRole="alert"><Copy style={{color:colors.danger}}>{error}</Copy></View><Action secondary label="Refresh review" disabled={working} onPress={() => {setLoading(true);setAttempt(value => value+1)}} /></Card> : null}
    {!board.online || syncPaused ? <Copy style={{color:colors.warning}}>Connect and finish unlocking parent controls to review or submit deletion.</Copy> : null}
    {record ? <Card><Copy>{occupied ? "Another account has a saved deletion request on this device. Its recovery information has been kept." : changed ? "Your sign-in or households changed after these choices were saved. Cancel the saved choices and review again." : "Your confirmed choices are saved on this device. They cannot be edited within this request."}</Copy>
      <Action secondary label="View saved request" disabled={working} onPress={() => setShowSaved(true)} /></Card> : null}
    {reviewLoading ? <Copy>Loading your account review…</Copy> : null}
    {review ? <View style={{flexDirection:width >= 850 ? "row" : "column",alignItems:"flex-start",gap:20}}>
      <View style={{flex:width >= 850 ? 1 : undefined,flexShrink:1,minWidth:0,width:width >= 850 ? undefined : "100%",gap:20}}>
        <Card><Copy tone="heading">Your account and content</Copy><Copy>Your sign-in, household memberships, invitations, preferences and notification history will be removed.</Copy>
          <Copy>{quantity(review.authoredContent.routines,"routine")}, {quantity(review.authoredContent.runs,"run")} and {quantity(review.authoredContent.tasks,"task")} created by you will be removed, including your content in shared or former households. Other members’ own content is preserved where the household continues.</Copy>
          {review.permanentOwnerAccess ? <Copy style={{color:colors.warning}}>Your permanent owner access will also be removed. It will not transfer to another household owner.</Copy> : null}
        </Card>
        {review.households.map(household => <Card key={household.id}><Copy tone="heading">{household.name}</Copy>
          {household.owned && household.ownership ? <>
            <Copy>{quantity(household.ownership.otherAccounts,"other signed-in member")} and {quantity(household.ownership.profilesWithoutSignIn,"profile")} without their own sign-in.</Copy>
            <Copy tone="muted">Choose what happens to this household.</Copy>
            {household.ownership.possibleSuccessors.map(member => <Choice key={member.id} label={`Transfer ownership to ${member.name}`} selected={choices[household.id]?.action === "transfer" && (choices[household.id] as {successorId?:string}).successorId === member.id}
              disabled={working || frozen} onPress={() => setChoices(previous => ({...previous,[household.id]:{householdId:household.id,action:"transfer",successorId:member.id}}))} />)}
            <Choice label="Delete this household for everyone" selected={choices[household.id]?.action === "delete"} disabled={working || frozen}
              onPress={() => setChoices(previous => ({...previous,[household.id]:{householdId:household.id,action:"delete"}}))} />
            <Copy tone="muted">Deleting the household removes its {quantity(household.ownership.content.routines,"routine")}, {quantity(household.ownership.content.runs,"run")} and {quantity(household.ownership.content.tasks,"task")} for every member. Profiles without a sign-in are removed if no other household uses them.</Copy>
            {household.ownership.possibleSuccessors.length === 0 ? <Copy tone="muted">No other signed-in manager or supervisor can currently take ownership. You can return to household settings to add or promote a parent first.</Copy> : null}
            {household.ownership.purchasePending ? <Copy style={{color:colors.warning}}>A subscription purchase is still pending for this household. Check billing before continuing.</Copy> : null}
            {household.ownership.billing.map((source,index) => <Copy key={`${source.provider}:${index}`} tone="muted">{source.provider === "stripe" ? "Web" : source.provider === "app_store" ? "Apple" : "Google Play"} subscription: {source.status.replaceAll("_"," ")}{source.environment === "sandbox" ? " (test purchase)" : ""}.{source.pendingPayment ? " Payment needs attention." : ""}</Copy>)}
          </> : <Copy>You will leave this household. It will remain available to its other members. Your own authored content will be removed.</Copy>}
        </Card>)}
      </View>
      <View style={{flex:width >= 850 ? 0.8 : undefined,flexShrink:1,minWidth:0,width:width >= 850 ? undefined : "100%",gap:20}}>
        <Card><Copy tone="heading">Subscriptions</Copy><Copy>Deleting your account does not cancel Apple or Google Play subscriptions. Cancel them in the store that bills you to stop future charges.</Copy>
          <Copy>For households you own, Cyntch will close your web billing customer and stop its subscriptions during deletion processing. A transferred household keeps any remaining verified paid access; its new owner will need their own billing arrangement afterward.</Copy>
          <Copy tone="muted">Some transaction records and minimal deletion records must remain to prevent duplicate purchases, repeated requests or restoration of deleted data.</Copy>
        </Card>
        <Card><Copy tone="heading">Confirm your choices</Copy>
          <View style={styles.row}><Switch accessibilityLabel="I understand the account and household deletion consequences" value={accountConsent} onValueChange={setAccountConsent} disabled={working || frozen} /><View style={{flex:1}}><Copy>I understand that this deletion is permanent and accept the household choices above.</Copy></View></View>
          <View style={styles.row}><Switch accessibilityLabel="I understand the subscription consequences" value={billingConsent} onValueChange={setBillingConsent} disabled={working || frozen} /><View style={{flex:1}}><Copy>I understand what happens to subscriptions and will cancel any store renewals I no longer want.</Copy></View></View>
          <Copy tone="muted">You may be asked to verify your identity. Nothing is deleted until Cyntch accepts the request.</Copy>
          <Action label={actions.busy ? "Confirming request…" : "Delete my account"} disabled={!canSubmit} onPress={confirm} />
        </Card>
      </View>
    </View> : null}
  </ScrollView>{actions.verification}</SafeAreaView>
}
