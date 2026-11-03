import type { PurchasesPackage, SubscriptionOption } from "react-native-purchases"
import { Platform } from "react-native"
import * as Linking from "expo-linking"
import { isWebBillingCancellationUrl, type NativeBillingSetup } from "../../../shared/mobile/billing"
import { BillingSdkQueue, type BillingOffer, type BillingSdk, type IdentifiedBillingStore } from "./billing-sdk"

type Reference = { package: PurchasesPackage; basePlan: SubscriptionOption | null }
const queue = new BillingSdkQueue()
let configuredKey: string | undefined
export const nativeBillingSdk: BillingSdk = {
  store: Platform.OS === "ios" ? "app_store" : Platform.OS === "android" ? "play_store" : null,
  async manage(store, check) {
    check()
    if (!nativeBillingSdk.store) throw new Error("Use the Android or iOS app to manage store subscriptions.")
    if (store !== "app_store" && store !== "play_store") throw new Error("Choose the store that bills this subscription.")
    // Management must remain reachable without SDK keys or current offerings.
    // Apple's web subscription page also supports parents using Android.
    const url = store === "play_store" ? "https://play.google.com/store/account/subscriptions"
      : Platform.OS === "ios" ? "https://apps.apple.com/account/subscriptions" : "https://account.apple.com/account/manage/section/subscriptions"
    try { await Linking.openURL(url) }
    catch { throw new Error(`Unable to open ${store === "app_store" ? "Apple" : "Google Play"} subscription management. Please try again or use that store’s subscription settings.`) }
  },
  async openWebCancellation(url, check) {
    check()
    if (!isWebBillingCancellationUrl(url)) throw new Error("This cancellation link is not valid. Please try again.")
    await Linking.openURL(url)
  },
  run<T>(setup: NativeBillingSetup, check: () => void, work: (store: IdentifiedBillingStore) => Promise<T>) {
    return queue.run(check, async () => {
      const { default: Purchases, LOG_LEVEL, PURCHASES_ERROR_CODE, RECURRENCE_MODE } = await import("react-native-purchases")
      check()
      if (setup.store !== nativeBillingSdk.store) throw new Error("This subscription belongs to a different app store.")
      if (configuredKey && configuredKey !== setup.publicSdkKey) throw new Error("Store settings changed. Restart Cyntch before managing subscriptions.")
      if (!configuredKey) {
        await Purchases.setLogLevel(LOG_LEVEL.ERROR); check()
        Purchases.configure({ apiKey: setup.publicSdkKey, appUserID: setup.billingCustomerId,
          shouldShowInAppMessagesAutomatically: false, automaticDeviceIdentifierCollectionEnabled: false })
        configuredKey = setup.publicSdkKey
      }
      const current = await Purchases.getAppUserID(); check()
      if (current !== setup.billingCustomerId) { await Purchases.logIn(setup.billingCustomerId); check() }
      const customer = await Purchases.getCustomerInfo(); check()
      if (customer.originalAppUserId !== setup.billingCustomerId) throw new Error("This store account is linked to another household. Restore purchases for the original household.")
      const available = new Set<unknown>()
      const session: IdentifiedBillingStore = {
        async offers() {
          check(); const offering = (await Purchases.getOfferings()).current; check()
          const offers: BillingOffer[] = []
          for (const approved of setup.products) {
            const matches = offering?.availablePackages.filter(item => item.product.identifier === approved.storeProductId) ?? []
            if (matches.length !== 1) throw new Error("The store’s subscription options are unavailable. Please try again shortly.")
            const item = matches[0], product = item.product, period = approved.interval === "monthly" ? "P1M" : "P1Y"
            let basePlan: SubscriptionOption | null = null, amount = product.price, price = product.priceString, currency = product.currencyCode
            if (setup.store === "play_store") {
              basePlan = product.subscriptionOptions?.find(option => option.isBasePlan && option.storeProductId === approved.storeProductId) ?? null
              const phase = basePlan?.fullPricePhase
              if (!basePlan || basePlan.isPrepaid || basePlan.installmentsInfo || basePlan.freePhase || basePlan.introPhase ||
                basePlan.pricingPhases.length !== 1 || phase?.billingPeriod.iso8601 !== period || phase.recurrenceMode !== RECURRENCE_MODE.INFINITE_RECURRING) {
                throw new Error("The store’s subscription terms need updating. Please try again later.")
              }
              amount = phase.price.amountMicros / 1_000_000; price = phase.price.formatted; currency = phase.price.currencyCode
            } else if (product.subscriptionPeriod !== period || product.introPrice || product.installmentsInfo) {
              throw new Error("The store’s subscription terms need updating. Please try again later.")
            }
            if (!Number.isFinite(amount) || amount <= 0 || !price || !currency) throw new Error("The store could not confirm the subscription price.")
            const reference: Reference = { package: item, basePlan }; available.add(reference)
            offers.push({ interval: approved.interval, productId: approved.storeProductId, price, currency, amount, reference })
          }
          return offers
        },
        async purchase(offer) {
          check()
          if (!available.has(offer.reference)) throw new Error("Refresh subscription prices before purchasing.")
          const reference = offer.reference as Reference
          try {
            if (reference.basePlan) await Purchases.purchaseSubscriptionOption(reference.basePlan)
            else await Purchases.purchasePackage(reference.package)
            return "purchased"
          } catch (error) {
            const code = String((error as { code?: unknown })?.code)
            if (code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return "cancelled"
            if (code === PURCHASES_ERROR_CODE.PAYMENT_PENDING_ERROR) return "pending"
            throw new Error("The store could not confirm the purchase. Cyntch will check its status before allowing another attempt.")
          }
        },
        async restore() { check(); await Purchases.restorePurchases() },
      }
      return work(session)
    })
  },
}
