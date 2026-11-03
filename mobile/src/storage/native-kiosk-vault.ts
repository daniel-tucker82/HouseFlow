import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync } from "expo-crypto"
import * as SecureStore from "expo-secure-store"
import { KioskPinVault } from "./kiosk-pin-vault"

// Parent PIN access is needed only while the device is unlocked. Never restore
// these capabilities onto another device and never use shared-device biometrics
// as evidence that the person unlocking Cyntch is a parent.
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
export const nativeKioskVault = new KioskPinVault({
  get: key => SecureStore.getItemAsync(key, options),
  set: (key, value) => SecureStore.setItemAsync(key, value, options),
  remove: key => SecureStore.deleteItemAsync(key, options),
}, {
  randomSecret: async () => [...await getRandomBytesAsync(32)].map(value => value.toString(16).padStart(2, "0")).join(""),
  digest: value => digestStringAsync(CryptoDigestAlgorithm.SHA256, value),
}, () => performance.now())
