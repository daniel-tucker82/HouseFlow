import * as SQLite from "expo-sqlite"
import * as SecureStore from "expo-secure-store"
import { getRandomBytesAsync, randomUUID } from "expo-crypto"
import { LocalStore, type LocalDatabase, type SqlConnection, type SqlValue } from "./local-store"
export { nativeKioskVault } from "./native-kiosk-vault"

// Expo opens a separate connection for exclusive transactions. Serialize writers so
// rapid taps and acknowledgements cannot contend for the same SQLite write lock.
class NativeDatabase implements LocalDatabase {
  private writer: Promise<unknown> = Promise.resolve()
  constructor(private readonly database: SQLite.SQLiteDatabase) {}
  execAsync(sql: string) { return this.database.execAsync(sql) }
  runAsync(sql: string, ...parameters: SqlValue[]) {
    return this.write(() => this.database.runAsync(sql, ...parameters))
  }
  getFirstAsync<T>(sql: string, ...parameters: SqlValue[]) { return this.database.getFirstAsync<T>(sql, ...parameters) }
  getAllAsync<T>(sql: string, ...parameters: SqlValue[]) { return this.database.getAllAsync<T>(sql, ...parameters) }
  withExclusiveTransactionAsync(work: (transaction: SqlConnection) => Promise<void>) {
    return this.write(() => this.database.withExclusiveTransactionAsync(work))
  }
  private write<T>(work: () => Promise<T>) {
    const result = this.writer.then(work, work)
    this.writer = result.catch(() => undefined)
    return result
  }
}

let store: Promise<LocalStore> | undefined
export function openLocalStore() {
  return store ??= SQLite.openDatabaseAsync("cyntch-v1.db").then(async database => {
    const local = new LocalStore(new NativeDatabase(database))
    await local.initialize()
    return local
  }).catch(error => { store = undefined; throw error })
}

let deviceId: Promise<string> | undefined
export function getDeviceId() {
  return deviceId ??= (async () => {
    const existing = await SecureStore.getItemAsync("cyntch.device-id")
    if (existing) return existing
    const created = randomUUID()
    await SecureStore.setItemAsync("cyntch.device-id", created, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY })
    return created
  })().catch(error => { deviceId = undefined; throw error })
}

let installationSecret: Promise<string> | undefined
export function getInstallationSecret() {
  return installationSecret ??= (async () => {
    const existing = await SecureStore.getItemAsync("cyntch.installation-secret")
    if (existing) return existing
    const created = [...await getRandomBytesAsync(32)].map(value => value.toString(16).padStart(2, "0")).join("")
    await SecureStore.setItemAsync("cyntch.installation-secret", created, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY })
    return created
  })().catch(error => { installationSecret = undefined; throw error })
}
