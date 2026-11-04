import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync } from "expo-crypto"
import * as SecureStore from "expo-secure-store"
import { fetch as expoFetch } from "expo/fetch"
import { AccountDeletionVault } from "../storage/account-deletion-vault"
import { AccountDeletionStatusApi } from "./account-deletion-status"
import { AccountDeletionDrafts } from "./account-deletion-drafts"
import { AccountDeletionWithdrawalApi } from "./account-deletion-withdrawal"
import { AccountDeletionSubmissionApi } from "./account-deletion-submission"
import type { AccountDeletionStore } from "../storage/account-deletion-store"
import { AccountDeletionRecoveryController } from "./account-deletion-recovery"
import { openLocalStore, nativeKioskVault } from "../storage/native-store"
import { resetNativeNotificationSession, waitForNativeNotification } from "./notification-native-session"
import { eraseNativeBillingIdentity } from "./native-billing-identity"

const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
export const nativeAccountDeletionVault = new AccountDeletionVault({
  get: key => SecureStore.getItemAsync(key, options),
  set: (key, value) => SecureStore.setItemAsync(key, value, options),
  remove: key => SecureStore.deleteItemAsync(key, options),
}, async () => [...await getRandomBytesAsync(32)].map(value => value.toString(16).padStart(2, "0")).join(""), __DEV__)

export function nativeAccountDeletionStatusApi() {
  return new AccountDeletionStatusApi(process.env.EXPO_PUBLIC_API_URL ?? "https://www.cyntch.com", (url, init) => expoFetch(url, init), __DEV__)
}

export function nativeAccountDeletionDrafts(journal: AccountDeletionStore) {
  return new AccountDeletionDrafts(journal, nativeAccountDeletionVault, value => digestStringAsync(CryptoDigestAlgorithm.SHA256, value), __DEV__)
}

export function nativeAccountDeletionWithdrawalApi() {
  return new AccountDeletionWithdrawalApi(process.env.EXPO_PUBLIC_API_URL ?? "https://www.cyntch.com",(url,init) => expoFetch(url,init),__DEV__)
}

export function nativeAccountDeletionSubmissionApi() {
  return new AccountDeletionSubmissionApi(process.env.EXPO_PUBLIC_API_URL ?? "https://www.cyntch.com",(url,init) => expoFetch(url,init),__DEV__)
}

let recoveryController: Promise<AccountDeletionRecoveryController> | undefined
export function nativeAccountDeletionRecovery() {
  return recoveryController ??= openLocalStore().then(store => new AccountDeletionRecoveryController(nativeAccountDeletionVault,
    nativeAccountDeletionDrafts(store.accountDeletion),nativeAccountDeletionStatusApi(),async record => {
      await store.deletedAccounts.eraseAccepted(record)
      const results = await Promise.allSettled([
        eraseNativeBillingIdentity(record.accountId),
        (async () => {
          for (const kioskId of await store.deletedAccounts.pendingKioskKeys(record.accountId)) {
            await nativeKioskVault.remove(kioskId)
            await store.deletedAccounts.acknowledgeKioskKey(record.accountId,record.requestId,kioskId)
          }
        })(),
        waitForNativeNotification(resetNativeNotificationSession(store.notificationSessions)),
      ])
      if (results.some(result => result.status === "rejected")) throw new Error("Some device cleanup still needs another attempt. Your saved deletion receipt has been kept.")
    },() => store.deletedAccounts.accounts())).catch(error => { recoveryController = undefined;throw error })
}
