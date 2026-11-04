import { useAuth, useReverification } from "@clerk/expo"
import { useLayoutEffect, useRef, useState } from "react"
import type { AccountDeletionRecovery, AccountDeletionSubmission, AccountDeletionScope } from "../../../shared/mobile/account-deletion"
import { AccountReverification, type ReverificationRequest } from "../components/account-reverification"
import { nativeAccountDeletionDrafts, nativeAccountDeletionSubmissionApi, nativeAccountDeletionWithdrawalApi } from "../services/native-account-deletion"
import { getDeviceId, getInstallationSecret, openLocalStore } from "../storage/native-store"
import type { SavedAccountDeletion } from "../storage/account-deletion-vault"
import { useAccountDeletionRecovery } from "./account-deletion-recovery"
import { useKiosk } from "./kiosk"
import { useNotificationSession } from "./notification-session"

export function useAccountDeletionActions() {
  const auth = useAuth({treatPendingAsSignedOut:false}), identity = useRef(auth)
  const mounted = useRef(true)
  useLayoutEffect(() => {mounted.current = true;return () => {mounted.current = false}},[])
  useLayoutEffect(() => {identity.current = auth},[auth])
  const {controller:kiosk} = useKiosk(), {isSessionActive} = useNotificationSession(), {controller:recovery} = useAccountDeletionRecovery()
  const [busy,setBusy] = useState(false), locked = useRef(false), target = useRef<AccountDeletionScope | null>(null)
  const [verification,setVerification] = useState<ReverificationRequest | null>(null)
  const allowed = (accountId: string, sessionId: string) => {
    const current = identity.current, protection = kiosk.getSnapshot()
    return mounted.current && current.isSignedIn && current.userId === accountId && current.sessionId === sessionId && isSessionActive(accountId,sessionId) && protection.ready && !protection.changing && !protection.record
  }
  async function credentials(accountId: string) {
    const sessionId = identity.current.sessionId
    if (!sessionId || !allowed(accountId,sessionId)) throw new Error("Sign in as this account and unlock parent controls before continuing.")
    const [deviceId,installationSecret,token] = await Promise.all([getDeviceId(),getInstallationSecret(),identity.current.getToken({skipCache:true})])
    if (!token || !allowed(accountId,sessionId)) throw new Error("Your sign-in changed. The saved deletion request has been kept.")
    return {accountId,sessionId,deviceId,installationSecret,token}
  }
  function onNeedsReverification(request: Omit<ReverificationRequest,"sessionId">) {
    const scope = target.current
    if (!scope || !allowed(scope.accountId,scope.sessionId)) {request.cancel();return}
    setVerification({...request,sessionId:scope.sessionId,
      complete:() => {if (mounted.current) setVerification(null);if (allowed(scope.accountId,scope.sessionId)) request.complete();else request.cancel()},
      cancel:() => {if (mounted.current) setVerification(null);request.cancel()}})
  }
  const submitVerified = useReverification(async (saved: AccountDeletionSubmission & {recovery: AccountDeletionRecovery}) => {
    return nativeAccountDeletionSubmissionApi().submit(saved,await credentials(saved.accountId))
  },{onNeedsReverification})
  const withdrawVerified = useReverification(async (saved: SavedAccountDeletion) => {
    return nativeAccountDeletionWithdrawalApi().withdraw(saved,await credentials(saved.accountId))
  },{onNeedsReverification})
  async function run(work: () => Promise<void>) {
    if (locked.current) return
    locked.current = true;setBusy(true)
    let failed = false
    try {await work()}
    catch (error) {failed = true;throw error}
    finally {
      target.current = null
      // Publishing the submitted marker only after the explicit operation ends
      // keeps its verification dialog mounted. Restart already reads that marker.
      try {await recovery.refresh()}
      catch (error) {if (!failed) throw error}
      finally {locked.current = false;if (mounted.current) setBusy(false)}
    }
  }
  const submit = (submission: AccountDeletionSubmission) => run(async () => {
    const current = await credentials(submission.accountId)
    target.current = current
    const drafts = nativeAccountDeletionDrafts((await openLocalStore()).accountDeletion)
    const saved = await drafts.prepare(submission)
    const payload = await drafts.requestForSubmission(saved,current)
    const receipt = await submitVerified(payload)
    await recovery.rememberStatus(saved,receipt.status)
  })
  const withdraw = (saved: SavedAccountDeletion) => run(async () => {
    target.current = await credentials(saved.accountId)
    const receipt = await withdrawVerified(saved)
    const drafts = nativeAccountDeletionDrafts((await openLocalStore()).accountDeletion)
    await drafts.rememberWithdrawal(saved,receipt,receipt)
    if (receipt.outcome === "accepted") await recovery.check()
  })
  return {submit,withdraw,busy,verification:verification ? <AccountReverification request={verification} /> : null}
}
