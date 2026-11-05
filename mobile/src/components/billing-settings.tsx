import { useCallback } from "react"
import { useFocusEffect } from "expo-router"
import { ActivityIndicator, Alert, View, useWindowDimensions } from "react-native"
import { Action, Card, Copy, styles, usePalette } from "./ui"
import { useBilling, useRuntime } from "../providers/runtime"
import { hasBillingConflict } from "../services/billing-controller"
import type { NativeBillingSource } from "../../../shared/mobile/billing"
import { PolicyLinks } from "./policy-links"
import { subscriptionPoliciesAvailable } from "../services/policy-links"

const providers = { app_store: "Apple App Store", play_store: "Google Play", stripe: "Cyntch website" }
function sourceDescription(source: NativeBillingSource) {
  if (source.pendingPayment) return "Waiting for payment or approval."
  if (["in_grace_period", "in_billing_retry", "past_due", "unpaid", "incomplete", "paused", "unknown"].includes(source.status)) return "This subscription needs attention in its billing provider."
  if (!source.givesAccess) return "This subscription does not currently provide Premium access."
  if (source.renewal === "will_not_renew") return source.accessThrough ? `Cancelled. Premium continues until ${new Date(source.accessThrough).toLocaleDateString()}.` : "Cancelled. Your remaining paid access is preserved."
  return source.accessThrough ? `Premium access confirmed through ${new Date(source.accessThrough).toLocaleDateString()}.` : "Premium subscription is active."
}
export function BillingSettingsCard() {
  const { billing, syncPaused } = useRuntime(), state = useBilling(), colors = usePalette()
  const { width, fontScale } = useWindowDimensions()
  useFocusEffect(useCallback(() => { billing.setVisible(true); return () => billing.setVisible(false) }, [billing]))
  const status = state.status, busy = Boolean(state.busy) || state.loading, disabled = busy || !state.online || syncPaused
  const eligible = status?.canManage && status.purchasesAvailable && !hasBillingConflict(status) && !state.operation
  const sources = status?.sources.filter(source => source.givesAccess || source.pendingPayment || !["expired", "not_returned", "canceled", "incomplete_expired"].includes(source.status)) ?? []
  const stores = [...new Set(sources.flatMap(source => source.provider === "stripe" ? [] : [source.provider]))]
  const run = (work: Promise<unknown>) => { void work.catch(() => undefined) } // Error is retained in the card, including after navigation.
  return <Card>
    <Copy tone="heading">Household plan</Copy>
    {state.household ? <Copy tone="muted">{state.household.name}</Copy> : <Copy tone="muted">Choose a household to see its plan.</Copy>}
    {status ? <>
      <View style={[styles.row, { flexWrap: "wrap", justifyContent: "space-between" }]}><Copy tone="heading">{status.tier === "free" ? "Free" : "Premium"}</Copy>
        {status.tier === "owner" ? <Copy tone="label">Permanent access</Copy> : null}</View>
      <Copy tone="muted">{status.tier === "owner" ? "Your household has permanent Premium access. No subscription is needed." : "One household plan, shared across your phones, tablets and the website."}</Copy>
      <Copy>{status.limits.templates} {status.limits.templates === 1 ? "routine" : "routines"} · {status.limits.items} tasks and rewards per routine · {status.limits.activeExecutions} active {status.limits.activeExecutions === 1 ? "board" : "boards"}</Copy>
      <Copy tone="muted">{status.limits.automation ? "Recurring routines and timed tasks included." : "Upgrade to add more routines, recurring schedules and timed tasks."}</Copy>
      {!status.canManage ? <Copy tone="muted">The household owner manages this plan.</Copy> : null}
      {status.duplicateSubscriptions ? <View accessibilityRole="alert"><Copy style={{ color: colors.warning }}>More than one subscription is providing Premium. Review them with their billing providers to avoid paying twice.</Copy></View> : null}
      {sources.map((source,index) => <View key={`${source.provider}:${index}`} style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 12, gap: 4 }}>
        <Copy tone="label">{providers[source.provider]}</Copy><Copy tone="muted">{sourceDescription(source)}</Copy>
        {source.provider === "stripe" && source.renewal !== "will_not_renew" && !["canceled","incomplete_expired","none"].includes(source.status) ? <>
          <Copy tone="muted">You can stop automatic renewal. Any remaining paid access continues until the end of your paid period.</Copy>
          <Action disabled={disabled} secondary label="Cancel website subscription" onPress={() => run(billing.cancelWebRenewal())} />
        </> : null}
      </View>)}
    </> : state.loading ? <View style={styles.row}><ActivityIndicator color={colors.primary} /><Copy tone="muted">Checking your household’s plan…</Copy></View> : null}
    {!state.online && state.household ? <Copy tone="muted">Connect to the internet to check or manage subscriptions. Your saved tasks are still available.</Copy> : null}
    {state.operation || status?.verificationPending || status?.purchase ? <View accessibilityLiveRegion="polite" style={{ gap: 4 }}>
      <Copy tone="label">{status?.purchase && !status.purchase.thisSession ? "A purchase is in progress on another device" : "Checking an earlier purchase"}</Copy>
      <Copy tone="muted">You can keep using Cyntch. Your plan will update after the store confirms the result.</Copy>
    </View> : null}
    {state.message ? <View accessibilityLiveRegion="polite"><Copy>{state.message}</Copy></View> : null}
    {state.error ? <View accessibilityRole="alert"><Copy style={{ color: colors.danger }}>{state.error}</Copy></View> : null}
    {state.busy ? <View style={styles.row}><ActivityIndicator color={colors.primary} /><Copy tone="muted">{state.busy === "prices" ? "Getting store prices…" : state.busy === "purchase" ? "Opening your store purchase…" : state.busy === "restore" ? "Restoring purchases…" : "Opening subscription management…"}</Copy></View> : null}
    {eligible && subscriptionPoliciesAvailable ? <>
      {!state.offers.length ? <Action disabled={disabled} label="View subscription options" onPress={() => run(billing.loadOffers())} /> : <View style={{ flexDirection: width >= 700 && fontScale <= 1.4 ? "row" : "column", gap: 12 }}>
        {state.offers.map(offer => <View key={offer.interval} style={{ flex: 1, borderRadius: 14, backgroundColor: colors.soft, padding: 16, gap: 8 }}>
          <Copy tone="label">{offer.interval === "monthly" ? "Monthly" : "Annual"}</Copy>
          <Copy tone="heading">{offer.price}</Copy><Copy tone="muted">{offer.currency} · {offer.interval === "monthly" ? "billed every month" : "billed once a year"}</Copy>
          <Action disabled={disabled} label={offer.interval === "monthly" ? "Subscribe monthly" : "Subscribe annually"} onPress={() => run(billing.purchase(offer.interval))} />
        </View>)}
      </View>}
      {state.offers.length ? <Copy tone="muted">Payment is charged to your store account. Your subscription renews automatically until cancelled in your store settings. Review the price and renewal terms in the purchase sheet.</Copy> : null}
      <PolicyLinks />
    </> : eligible ? <Copy tone="muted">Subscription options are temporarily unavailable. You can still manage or restore an existing subscription.</Copy>
    : status?.canManage && status.tier === "free" && !status.purchasesAvailable ? <Copy tone="muted">Store subscriptions are not available yet.</Copy> : null}
    {status?.canManage && stores.length ? <Copy tone="muted">Manage your existing subscription using the Apple or Google account that originally purchased it.</Copy> : null}
    {status?.canManage ? stores.map(store => <Action key={store} disabled={disabled} secondary label={`Manage ${store === "app_store" ? "Apple" : "Google Play"} subscription`} onPress={() => run(billing.manage(store))} />) : null}
    {status?.canManage && status.purchasesAvailable ? <>
      <Action disabled={disabled} secondary label="Restore purchases" onPress={() => Alert.alert("Restore purchases for this household?", "Use the same store account that originally subscribed for this household. Purchases belonging to another household will stay with that household.", [
        { text: "Cancel", style: "cancel" }, { text: "Restore", onPress: () => run(billing.restore()) },
      ])} />
    </> : null}
    {state.household ? <Action disabled={disabled} secondary label="Refresh plan status" onPress={() => run(billing.refresh())} /> : null}
  </Card>
}
