import { BillingIdentityController, type BillingIdentityDriver, waitForBillingIdentityCleanup } from "./billing-identity"
import { openLocalStore } from "../storage/native-store"

async function sdkCall<T>(work: (purchases: typeof import("react-native-purchases")) => Promise<T>) {
  try {return await work(await import("react-native-purchases"))}
  catch {throw new Error("Store identity could not be confirmed. Your saved recovery information has been kept. Please try again.")}
}
const driver: BillingIdentityDriver = {
  async isConfigured() {return sdkCall(purchases => purchases.default.isConfigured())},
  async configure(identity,resumeCachedIdentity,check) {
    await sdkCall(async ({default: Purchases,LOG_LEVEL}) => {
      await Purchases.setLogLevel(LOG_LEVEL.ERROR)
      check()
      Purchases.configure({apiKey:identity.publicSdkKey,...(resumeCachedIdentity ? {} : {appUserID:identity.billingCustomerId}),
        shouldShowInAppMessagesAutomatically:false,automaticDeviceIdentifierCollectionEnabled:false})
    })
  },
  async current() {return sdkCall(purchases => purchases.default.getAppUserID())},
  async isAnonymous() {return sdkCall(purchases => purchases.default.isAnonymous())},
  async logIn(customerId,check) {await sdkCall(purchases => {check();return purchases.default.logIn(customerId)})},
  async logOut() {await sdkCall(purchases => purchases.default.logOut())},
}
let controller: Promise<BillingIdentityController> | undefined
export function nativeBillingIdentity() {
  return controller ??= openLocalStore().then(store => new BillingIdentityController(store.billingIdentity,driver)).catch(error => {controller = undefined;throw error})
}
export async function eraseNativeBillingIdentity(accountId: string) {
  const current = await nativeBillingIdentity()
  await waitForBillingIdentityCleanup(current.eraseDeletedAccount(accountId))
}
