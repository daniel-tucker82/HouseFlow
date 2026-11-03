"use client"

import { useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import { isCapacitorNativeShellSync } from "@/lib/native-shell-detect"
import type { HouseholdTier } from "@/lib/billing-policy"

const subscribe = () => () => {}
export function BillingControls({householdId,tier,canBill,canManage,templates,selectedTemplate}: {
  householdId:string;tier:HouseholdTier;canBill:boolean;canManage:boolean;
  templates:{id:string;name:string}[];selectedTemplate:string
}) {
  const router = useRouter()
  const native = useSyncExternalStore(subscribe,isCapacitorNativeShellSync,() => true)
  const [busy,setBusy] = useState(false)
  const [message,setMessage] = useState("")
  const [routineId,setRoutineId] = useState(selectedTemplate)
  async function submit(action:string, values:Record<string,string> = {}) {
    if (busy) return
    setBusy(true); setMessage("")
    try {
      const response = await fetch("/api/billing/" + action, {method:"POST", headers:{"Content-Type":"application/json"},body:JSON.stringify({householdId,...values})})
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "Please try again.")
      if (result.url) window.location.assign(result.url)
      else { setMessage("Saved."); router.refresh() }
    } catch(error) { setMessage(error instanceof Error ? error.message : "Please try again.") }
    finally { setBusy(false) }
  }
  const buttonClass = "rounded-lg border px-4 py-2 disabled:opacity-50"
  return <section className="space-y-4">
    {!native && canBill && tier !== "owner" && <div className="space-y-3">
      {tier === "free" && <>
        <h2 className="text-lg font-medium">Upgrade to Premium</h2>
        <p>More templates and items, recurring schedules, timed activation and expiry for your household.</p>
        <div className="flex flex-wrap gap-3">
          <button disabled={busy} className={buttonClass} onClick={() => void submit("checkout",{interval:"monthly"})}>A$5.99 / month</button>
          <button disabled={busy} className={buttonClass} onClick={() => void submit("checkout",{interval:"yearly"})}>A$49.99 / year</button>
        </div>
      </>}
      <button disabled={busy} className={buttonClass} onClick={() => void submit("portal")}>Manage subscription</button>
      <button disabled={busy} className={buttonClass} onClick={() => void submit("reconcile")}>Refresh billing status</button>
    </div>}
    {!canBill && !native && <p>The household owner manages its subscription.</p>}
    {tier === "free" && canManage && templates.length > 0 && <div className="space-y-2">
      <label htmlFor="free-template" className="block font-medium">Your free template</label>
      <select id="free-template" value={routineId} onChange={e => setRoutineId(e.target.value)} className="w-full rounded border p-2">
        {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <button disabled={busy || !routineId} className={buttonClass} onClick={() => void submit("selection",{routineId})}>Use this template</button>
    </div>}
    <p role="status" aria-live="polite">{message}</p>
  </section>
}
