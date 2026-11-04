import * as SecureStore from "expo-secure-store"
import { ClerkOfflineCache, waitForClerkOfflineCleanup } from "../storage/clerk-offline-cache"
import { SecureResourceStore } from "../storage/secure-resource-store"
import { openLocalStore } from "../storage/native-store"

// Matches the installed Clerk cache's accessibility so existing offline sign-in
// continues to work after a device restart and its first unlock.
const options = {keychainAccessible:SecureStore.AFTER_FIRST_UNLOCK}
let cache: ClerkOfflineCache | undefined
function current() {
  return cache ??= new ClerkOfflineCache(new SecureResourceStore({
    get:key => SecureStore.getItemAsync(key,options),
    set:(key,value) => SecureStore.setItemAsync(key,value,options),
    remove:key => SecureStore.deleteItemAsync(key,options),
  }),process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "",async () => (await openLocalStore()).deletedAccounts.accounts())
}
async function safe<T>(work: () => Promise<T>) {
  try {return await work()}
  catch {throw new Error("Saved sign-in information could not be updated. Please try again.")}
}
export function nativeClerkResourceCache() {
  return {get:(key:string) => safe(() => current().get(key)),set:(key:string,value:string) => safe(() => current().set(key,value))}
}
export function eraseNativeClerkOfflineCache(accountId: string) {
  return safe(() => waitForClerkOfflineCleanup(current().eraseDeletedAccount(accountId)))
}
