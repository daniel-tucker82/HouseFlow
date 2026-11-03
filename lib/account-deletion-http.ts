import { clerkClient } from "@clerk/nextjs/server"
import { AccountDeletionError } from "@/lib/account-deletion-review"

/** Native confirmation is a small, explicit JSON intent. Bound bytes even when
 * Content-Length is missing or false; a stalled upload cannot retain a reader. */
export async function readAccountDeletionBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AccountDeletionError("Send the confirmed deletion request as JSON.",415)
  }
  if (Number(request.headers.get("content-length")) > 65_536) throw new AccountDeletionError("The deletion request is too large.",413)
  const reader = request.body?.getReader()
  if (!reader) throw new AccountDeletionError("Review and confirm deletion before submitting.")
  let interrupted = false, bytes = 0
  const chunks: Uint8Array[] = []
  const cancel = () => { interrupted = true; void reader.cancel().catch(() => undefined) }
  const timeout = setTimeout(cancel,5_000)
  request.signal.addEventListener("abort",cancel)
  try {
    if (request.signal.aborted) cancel()
    while (true) {
      const { value, done } = await reader.read()
      if (interrupted) throw new AccountDeletionError("The request was interrupted. Check its saved status before trying again.",408)
      if (done) break
      bytes += value.byteLength
      if (bytes > 65_536) { void reader.cancel().catch(() => undefined); throw new AccountDeletionError("The deletion request is too large.",413) }
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) }
    catch { throw new AccountDeletionError("The confirmed deletion request could not be read.") }
  } finally { clearTimeout(timeout);request.signal.removeEventListener("abort",cancel);reader.releaseLock() }
}

/** A local member profile is not proof of an available sign-in. This read is
 * outside the deletion transaction; membership and account tombstones are
 * rechecked by acceptance under its locks. Never return provider user data.
 * The SDK has no per-call AbortSignal. A timed-out read may finish, but has no
 * continuation that can accept a deletion or transfer a household. */
export async function verifyAccountDeletionSuccessors(ids: string[]) {
  if (!ids.length) return
  if (ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !/^user_[A-Za-z0-9_-]{1,200}$/.test(id))) throw new AccountDeletionError("Review the household ownership choices again.")
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      (async () => (await clerkClient()).users.getUserList({ userId: ids,limit: ids.length }))(),
      new Promise<never>((_,reject) => { timeout = setTimeout(() => reject(new Error("identity_lookup_timeout")),8_000) }),
    ])
    if (!Array.isArray(result.data) || result.data.length !== ids.length || new Set(result.data.map(user => user.id)).size !== ids.length ||
      result.data.some(user => !ids.includes(user.id) || user.banned !== false || user.locked !== false)) {
      throw new AccountDeletionError("A selected parent can no longer take over the household. Review your choices again.",409,"account_deletion_review_changed")
    }
  } catch (error) {
    if (error instanceof AccountDeletionError) throw error
    throw new AccountDeletionError("Unable to verify the selected parents. Keep the saved request and try again.",503,"account_deletion_verification_unavailable")
  } finally { clearTimeout(timeout) }
}
