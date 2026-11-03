import { redirect } from "next/navigation"
import { db } from "@/lib/db"
import { getCurrentUserOrRedirect, getUserHouseholds } from "@/lib/data"
import { getHouseholdEntitlement } from "@/lib/entitlements"
import { BillingControls } from "./billing-controls"

export default async function BillingPage({searchParams}: {searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const user = await getCurrentUserOrRedirect()
  const memberships = await getUserHouseholds(user.id)
  if (!memberships.length) redirect("/app")
  const params = await searchParams
  const membership = memberships.find(m => m.household.id === params.household) ?? memberships[0]
  const household = membership.household
  const client = await db.connect()
  try {
    const entitlement = await getHouseholdEntitlement(client, household.id)
    const billing = await client.query("select subscription_status, paid_through, cancel_at_period_end from household_billing where household_id = $1::uuid", [household.id])
    const templates = await client.query<{id:string;name:string}>("select id,name from routines where household_id = $1::uuid order by created_at,id", [household.id])
    return <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Household plan</h1>
      {entitlement.rolloutPending && <p role="status">Plan setup is in progress. Subscription restrictions have not been enabled.</p>}
      {params.checkout === "complete" && <p role="status">Checkout returned successfully. Payment confirmation may take a moment. Refresh billing status below to check your access.</p>}
      <form method="get" className="flex gap-2">
        <label htmlFor="household" className="sr-only">Household</label>
        <select id="household" name="household" defaultValue={household.id} className="min-w-0 flex-1 rounded border p-2">
          {memberships.map(m => <option key={m.household.id} value={m.household.id}>{m.household.name}</option>)}
        </select>
        <button className="rounded border px-4" type="submit">View</button>
      </form>
      <div className="rounded-xl border bg-card p-5 space-y-3">
        <h2 className="text-xl font-medium">{entitlement.tier === "owner" ? "Permanent Premium access" : entitlement.tier === "premium" ? "Premium" : "Free"}</h2>
        <p>{entitlement.tier === "owner" ? "All Premium features are included permanently for your household. No subscription is required." :
          entitlement.tier === "premium" ? "Premium features are available to everyone in this household." :
          "One template with up to 15 tasks and rewards combined. Start runs manually, with one active run at a time. Completion dependencies are included."}</p>
        <p>{entitlement.limits.templates} template{entitlement.limits.templates === 1 ? "" : "s"} · {entitlement.limits.items} items per template · {entitlement.limits.activeExecutions} active run{entitlement.limits.activeExecutions === 1 ? "" : "s"}</p>
        {billing.rows[0]?.subscription_status && billing.rows[0].subscription_status !== "none" &&
          <p>Subscription: {billing.rows[0].subscription_status}{billing.rows[0].cancel_at_period_end ? " — cancels at period end" : ""}.</p>}
        {billing.rows[0]?.paid_through && <p>Paid access through {new Date(billing.rows[0].paid_through).toLocaleDateString("en-AU", {timeZone:"Australia/Sydney"})}.</p>}
      </div>
      <BillingControls householdId={household.id} tier={entitlement.tier} canBill={!entitlement.rolloutPending && entitlement.leaderId === user.id}
        canManage={["manager","leader","supervisor"].includes(membership.role)} templates={templates.rows}
        selectedTemplate={entitlement.freeRoutineId ?? templates.rows[0]?.id ?? ""} />
      <p className="text-sm text-muted-foreground">Downgrading preserves your templates and history. Scheduled generation and time triggers stop when Premium access ends. Select one free template and remove its time rules to continue manual use.</p>
    </main>
  } finally { client.release() }
}
