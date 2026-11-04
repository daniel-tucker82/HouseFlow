import { useSession } from "@clerk/expo"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { KeyboardAvoidingView, Platform, ScrollView, TextInput, View } from "react-native"
import { AppModal } from "./app-modal"
import { SafeAreaView } from "react-native-safe-area-context"
import { Action, Card, Copy, styles, usePalette } from "./ui"

type Session = NonNullable<ReturnType<typeof useSession>["session"]>
type Verification = Awaited<ReturnType<Session["startVerification"]>>
type Factor = NonNullable<Verification["supportedFirstFactors"]>[number] | NonNullable<Verification["supportedSecondFactors"]>[number]
export interface ReverificationRequest { sessionId: string; level: "first_factor" | "second_factor" | "multi_factor" | undefined; complete: () => void; cancel: () => void }
function label(factor: Factor) {
  return factor.strategy === "email_code" ? `Email a code to ${factor.safeIdentifier}` : factor.strategy === "phone_code" ? `Send a code to ${factor.safeIdentifier}` :
    factor.strategy === "password" ? "Use your password" : factor.strategy === "totp" ? "Use an authenticator code" : factor.strategy === "backup_code" ? "Use a backup code" : "Use a passkey"
}

/** Custom native UI for Clerk's supported factors. Passwords/codes remain in
 * component memory only; completion requires Clerk's completed verification for
 * the same session. The retried mutation still has to pass server verification. */
export function AccountReverification({request}: {request: ReverificationRequest}) {
  const {session} = useSession(), colors = usePalette()
  const sessionRef = useRef(session), callbacks = useRef(request), alive = useRef(true), working = useRef(false), settled = useRef(false)
  const [verification,setVerification] = useState<Verification | null>(null), [factor,setFactor] = useState<Factor | null>(null)
  const [value,setValue] = useState(""), [busy,setBusy] = useState(true), [error,setError] = useState<string | null>(null), [attempt,setAttempt] = useState(0)
  useLayoutEffect(() => { sessionRef.current = session;callbacks.current = request },[session,request])
  const finish = useCallback((completed: boolean) => {
    if (settled.current) return
    settled.current = true
    if (completed && alive.current && sessionRef.current?.id === callbacks.current.sessionId) callbacks.current.complete()
    else callbacks.current.cancel()
  },[])
  useEffect(() => {
    if (session?.id !== request.sessionId) finish(false)
  },[session?.id,request.sessionId,finish])
  useEffect(() => {
    alive.current = true
    // A Strict Mode effect replay remounts synchronously. Only an actual
    // unmount cancels, and completion/cancellation can settle the request once.
    return () => { alive.current = false;queueMicrotask(() => { if (!alive.current) finish(false) }) }
  },[finish])
  useEffect(() => {
    let active = true
    const current = sessionRef.current
    if (settled.current || !current || current.id !== request.sessionId) return
    working.current = true
    void current.startVerification({level:request.level ?? "second_factor"}).then(result => {
      if (!active || !alive.current || settled.current || sessionRef.current?.id !== request.sessionId) return
      if (result.status === "complete") finish(true)
      else setVerification(result)
    }).catch(() => { if (active) setError("Unable to start verification. Connect and try again.") }).finally(() => { if (active) {working.current = false;setBusy(false)} })
    return () => { active = false }
  },[request.sessionId,request.level,attempt,finish])
  async function perform(work: (session: Session) => Promise<Verification>, selected?: Factor) {
    const current = sessionRef.current
    if (settled.current || working.current || !current || current.id !== request.sessionId) return
    working.current = true;setBusy(true);setError(null)
    try {
      const result = await work(current)
      if (!alive.current || settled.current || sessionRef.current?.id !== request.sessionId) return
      setValue("")
      if (result.status === "complete") finish(true)
      else {setVerification(result);setFactor(selected && result.status === verification?.status ? selected : null)}
    } catch {
      if (alive.current) setError("Verification was not completed. Check your details or try another method.")
    } finally { working.current = false;if (alive.current) setBusy(false) }
  }
  function choose(selected: Factor) {
    setValue("");setError(null)
    if (selected.strategy === "passkey") return void perform(current => current.verifyWithPasskey(verification?.status === "needs_second_factor" ? {level:"second_factor"} : {}))
    if (selected.strategy === "email_code") return void perform(current => current.prepareFirstFactorVerification({strategy:"email_code",emailAddressId:selected.emailAddressId}),selected)
    if (selected.strategy === "phone_code") return void perform(current => verification?.status === "needs_second_factor"
      ? current.prepareSecondFactorVerification({strategy:"phone_code",phoneNumberId:selected.phoneNumberId})
      : current.prepareFirstFactorVerification({strategy:"phone_code",phoneNumberId:selected.phoneNumberId}),selected)
    setFactor(selected)
  }
  function verify() {
    if (!factor || !value) return
    void perform(current => {
      if (verification?.status === "needs_second_factor" && (factor.strategy === "phone_code" || factor.strategy === "totp" || factor.strategy === "backup_code")) {
        return current.attemptSecondFactorVerification({strategy:factor.strategy,code:value.trim()})
      }
      if (verification?.status === "needs_first_factor") {
        if (factor.strategy === "password") return current.attemptFirstFactorVerification({strategy:"password",password:value})
        if (factor.strategy === "email_code" || factor.strategy === "phone_code") return current.attemptFirstFactorVerification({strategy:factor.strategy,code:value.trim()})
      }
      throw new Error("Unsupported verification method")
    })
  }
  const factors = (verification?.status === "needs_second_factor" ? verification.supportedSecondFactors : verification?.supportedFirstFactors)?.filter(item => item.strategy !== "enterprise_sso") ?? []
  return <AppModal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => finish(false)}><SafeAreaView style={{flex:1,backgroundColor:colors.background}}>
    <KeyboardAvoidingView style={{flex:1}} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <Copy tone="title">Verify your identity</Copy><Copy tone="muted">Confirm that it’s you before changing your account.</Copy>
      <Card>{error ? <View accessibilityRole="alert"><Copy style={{color:colors.danger}}>{error}</Copy></View> : null}
        {busy ? <Copy>Verifying…</Copy> : null}
        {factor ? <>
          <Copy>{factor.strategy === "password" ? "Your password" : "Verification code"}</Copy>
          <TextInput accessibilityLabel={factor.strategy === "password" ? "Your password" : "Verification code"} value={value} onChangeText={setValue} editable={!busy} secureTextEntry={factor.strategy === "password"}
            autoCapitalize="none" autoCorrect={false} textContentType={factor.strategy === "password" ? "password" : "oneTimeCode"} onSubmitEditing={verify}
            style={{minHeight:52,padding:14,borderWidth:1,borderColor:colors.border,borderRadius:12,color:colors.text,fontSize:18}} />
          <Action label="Verify and continue" disabled={busy || !value} onPress={verify} />
          {(factor.strategy === "email_code" || factor.strategy === "phone_code") ? <Action secondary label="Send a new code" disabled={busy} onPress={() => choose(factor)} /> : null}
          <Action secondary label="Use another method" disabled={busy} onPress={() => {setFactor(null);setValue("")}} />
        </> : factors.map((item,index) => <Action key={`${item.strategy}:${index}`} secondary label={label(item)} disabled={busy} onPress={() => choose(item)} />)}
        {!busy && !verification ? <Action label="Try again" onPress={() => {setBusy(true);setError(null);setAttempt(value => value+1)}} /> : null}
        {!busy && verification && factors.length === 0 ? <Copy>This account has no supported verification method available. Cancel, then check your sign-in methods in account settings.</Copy> : null}
      </Card><Action secondary label="Cancel verification" onPress={() => finish(false)} />
    </ScrollView></KeyboardAvoidingView>
  </SafeAreaView></AppModal>
}
