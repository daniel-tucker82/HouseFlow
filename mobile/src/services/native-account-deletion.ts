import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync } from "expo-crypto"
import * as SecureStore from "expo-secure-store"
import { fetch as expoFetch } from "expo/fetch"
import { AccountDeletionVault } from "../storage/account-deletion-vault"
import { AccountDeletionStatusApi } from "./account-deletion-status"
import { AccountDeletionDrafts } from "./account-deletion-drafts"
import { AccountDeletionWithdrawalApi } from "./account-deletion-withdrawal"
import { AccountDeletionSubmissionApi } from "./account-deletion-submission"
import type { AccountDeletionStore } from "../storage/account-deletion-store"

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
