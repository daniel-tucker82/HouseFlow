"use client"

import { useAuth } from "@clerk/nextjs"
import { useEffect, useState } from "react"
import { validateTermsStatus, type TermsStatus } from "@/shared/terms-consent"

export function TermsConsentNotice() {
  const { userId, isLoaded } = useAuth()
  const [status, setStatus] = useState<TermsStatus | null>(null), [agreed, setAgreed] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!isLoaded || !userId) return
    let cancelled = false
    const refresh = () => { void fetch('/api/mobile/terms', { cache: 'no-store' }).then(async response => {
      if (!response.ok) return
      const value = validateTermsStatus(await response.json(), userId)
      if (!cancelled) { setStatus(value); setAgreed(false) }
    }).catch(() => undefined) }
    refresh(); window.addEventListener('online', refresh); window.addEventListener('focus', refresh)
    return () => { cancelled = true; window.removeEventListener('online', refresh); window.removeEventListener('focus', refresh) }
  }, [isLoaded, userId])
  if (!userId || status?.accountId !== userId || !status.required || status.acceptedAt) return null
  async function accept() {
    if (!userId || !status || !agreed || saving) return
    setSaving(true); setError(null)
    try {
      const response = await fetch('/api/mobile/terms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: userId, version: status.version, agree: true }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Unable to confirm your agreement. Please retry.')
      const value = validateTermsStatus(body, userId)
      if (!value.acceptedAt || value.version !== status.version) throw new Error('Your agreement could not be confirmed. Please retry.')
      setStatus(value); setAgreed(false)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to confirm your agreement. Please retry.') }
    finally { setSaving(false) }
  }
  return <aside aria-label="Terms agreement" className="border-b border-border bg-muted px-5 py-4 text-sm">
    <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
      <p>Read and accept the <a className="font-semibold underline" href={status.url} target="_blank" rel="noreferrer">Terms of use</a> before creating or editing shared content. Existing task completion remains available.</p>
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={agreed} disabled={saving} onChange={event => setAgreed(event.target.checked)} />I have read and agree to the Terms of use (version {status.version}).</label>
      <button type="button" className="min-h-11 rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50" disabled={!agreed || saving} onClick={() => void accept()}>{saving ? 'Confirming agreement…' : 'Accept and continue'}</button>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    </div>
  </aside>
}
