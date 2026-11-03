import type Stripe from "stripe"
import { EntitlementError, withHouseholdWrite } from "@/lib/entitlements"
import { billingOrigin, stripeClient } from "@/lib/stripe-billing"
import { isWebBillingCancellationUrl, type NativeBillingScope, type WebBillingCancellation } from "@/shared/mobile/billing"

const options = { timeout: 8_000, maxNetworkRetries: 0 }
async function binding(scope: NativeBillingScope) {
  return withHouseholdWrite(scope.householdId,scope.accountId,async (client,entitlement) => {
    if (entitlement.leaderId !== scope.accountId) throw new EntitlementError("Only the household owner can manage billing.")
    const row = (await client.query<{ stripe_customer_id: string | null; stripe_subscription_id: string | null }>(
      "select stripe_customer_id,stripe_subscription_id from household_billing where household_id=$1::uuid",[scope.householdId])).rows[0]
    if (!row?.stripe_customer_id || !row.stripe_subscription_id) throw new EntitlementError("No website subscription exists for this household.",404)
    return { customer: row.stripe_customer_id, subscription: row.stripe_subscription_id }
  })
}
function assertConfiguration(config: Stripe.BillingPortal.Configuration, origin: string) {
  const features = config.features
  // This is a dedicated cancellation flow, never the website's default portal.
  // Reject a changed dashboard configuration rather than exposing upgrades or payment pages.
  if (!config.active || config.is_default || config.login_page.enabled ||
    !features.subscription_cancel.enabled || features.subscription_cancel.mode !== "at_period_end" ||
    features.subscription_cancel.proration_behavior !== "none" ||
    Object.entries(features).some(([name,feature]) => name !== "subscription_cancel" && feature.enabled !== false) ||
    [config.business_profile.privacy_policy_url,config.business_profile.terms_of_service_url].some(url => url && ![`${origin}/legal/privacy`,`${origin}/legal/terms`].includes(url))) {
    throw new EntitlementError("Website cancellation settings need attention. Please try again later.",503)
  }
}
/** Creating a link makes no billing change. Stripe asks the parent to confirm.
 * Provider I/O is outside the household lock; ownership/binding are rechecked. */
export async function prepareWebBillingCancellation(scope: NativeBillingScope): Promise<WebBillingCancellation> {
  const before = await binding(scope)
  const configuration = process.env.STRIPE_NATIVE_CANCEL_PORTAL_CONFIG_ID
  if (!configuration || !/^bpc_[a-zA-Z0-9]+$/.test(configuration)) throw new EntitlementError("Website cancellation is not configured yet.",503)
  const stripe = stripeClient(), origin = billingOrigin()
  const [subscription,config] = await Promise.all([
    stripe.subscriptions.retrieve(before.subscription,{},options),
    stripe.billingPortal.configurations.retrieve(configuration,{},options),
  ])
  const prices = new Set([process.env.STRIPE_MONTHLY_PRICE_ID,process.env.STRIPE_YEARLY_PRICE_ID].filter(Boolean))
  if (subscription.id !== before.subscription || subscription.customer !== before.customer || subscription.metadata.household_id !== scope.householdId ||
    subscription.items.has_more || subscription.items.data.length !== 1 || subscription.items.data[0].quantity !== 1 ||
    prices.size !== 2 || !prices.has(subscription.items.data[0].price.id) || subscription.livemode !== config.livemode) {
    throw new EntitlementError("The billing provider could not confirm this household’s subscription.",409)
  }
  if (["canceled","incomplete_expired"].includes(subscription.status) || subscription.cancel_at_period_end || subscription.cancel_at != null) {
    throw new EntitlementError("This subscription is already cancelled or scheduled to end. Refresh the plan to see its status.",409)
  }
  assertConfiguration(config,origin)
  const recheck = async () => {
    const current = await binding(scope)
    if (current.customer !== before.customer || current.subscription !== before.subscription) throw new EntitlementError("The household’s billing account changed. Please try again.",409)
  }
  await recheck()
  const returnUrl = `${origin}/mobile/billing/return`
  const session = await stripe.billingPortal.sessions.create({ customer: before.customer, configuration, return_url: returnUrl,
    flow_data: { type: "subscription_cancel", subscription_cancel: { subscription: before.subscription },
      after_completion: { type: "redirect", redirect: { return_url: returnUrl } } } },options)
  await recheck()
  if (session.customer !== before.customer || (typeof session.configuration === "string" ? session.configuration : session.configuration.id) !== configuration ||
    session.livemode !== config.livemode || !isWebBillingCancellationUrl(session.url)) throw new EntitlementError("The billing provider returned an unexpected cancellation link.",503)
  return { ...scope, provider: "stripe", url: session.url }
}
