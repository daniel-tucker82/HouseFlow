import { getClerkInstance } from "@clerk/expo"
import { inspectNativeClerkAccount, inspectNativeClerkPersistence } from "../../modules/cyntch-clerk-state"
import { openLocalStore } from "../storage/native-store"

let tail: Promise<unknown> = Promise.resolve()
const incomplete = () => new Error("Sign-in cleanup is still being verified. Keep the saved deletion receipt and try again.")

/** A shared device credential must not be erased merely because one account was
 * deleted. Refresh through Clerk's existing SDK, then verify both clients. A
 * missing bridge, unloaded client or unscoped profile is not proof of cleanup.
 * No tokens or provider profile payloads leave this boundary. */
export async function verifyNativeClerkDeletion(accountId: string, timeoutMs = 8_000) {
  const work = tail.then(async () => {
    if (!await (await openLocalStore()).deletedAccounts.isDeleted(accountId)) throw incomplete()
    const clerk = getClerkInstance()
    if (!clerk.loaded || !clerk.client) throw incomplete()
    const native = await inspectNativeClerkAccount(accountId,true)
    if (!native.ready || native.hasAccount || native.hasUnidentifiedSession || native.hasAuthenticationSnapshot) throw incomplete()
    // The native refresh's JS invalidation notification is asynchronous. Await
    // the supported JS refresh rather than mistaking propagation lag for a
    // completed cleanup, then recheck native state after that network boundary.
    await clerk.client.reload()
    const persisted = await inspectNativeClerkPersistence(accountId)
    if (!persisted.ready || persisted.hasAccount || persisted.hasUnidentifiedSession || persisted.hasAuthenticationSnapshot) throw incomplete()
    const settledNative = await inspectNativeClerkAccount(accountId)
    if (!settledNative.ready || settledNative.hasAccount || settledNative.hasUnidentifiedSession || settledNative.hasAuthenticationSnapshot) throw incomplete()
    const client = clerk.client
    if (!clerk.loaded || !client || clerk.user?.id === accountId || client.signIn.id || client.signUp.id ||
      client.sessions.some(session => !session.user || session.user.id === accountId)) throw incomplete()
  })
  tail = work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {await Promise.race([work,new Promise<never>((_,reject) => {timer=setTimeout(() => reject(incomplete()),timeoutMs)})])}
  catch {throw incomplete()}
  finally {clearTimeout(timer)}
}
