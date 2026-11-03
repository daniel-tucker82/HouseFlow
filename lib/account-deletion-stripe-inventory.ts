import type Stripe from "stripe"
import type { AccountDeletionWork } from "@/lib/account-deletion-requests"
import { AccountDeletionProcessingError } from "@/lib/account-deletion-processing"

const failed=()=>new AccountDeletionProcessingError("stripe_cleanup_failed")
type Progress=Pick<AccountDeletionWork,"stripe"|"stripeDiscovery">

/** Enumerate the regular customer list, not eventually-consistent search.
 * Persist every page before proceeding; unrelated customer details are never
 * stored. Test-clock customers are a separate Stripe list and are included in
 * test mode. No deletion begins until every inventory page has been saved. */
export async function inventoryAccountStripeCustomers(work:AccountDeletionWork,client:Stripe,livemode:boolean,
  options:()=>Promise<Stripe.RequestOptions>,save:(progress:Progress)=>Promise<void>):Promise<Progress> {
  const scopes=new Map(work.stripeHouseholds.map(scope=>[scope.householdId,scope.action]))
  let progress:Progress={stripe:work.stripe,stripeDiscovery:work.stripeDiscovery}
  if(progress.stripeDiscovery.livemode!==null && progress.stripeDiscovery.livemode!==livemode) throw failed()
  if(progress.stripeDiscovery.complete) return progress
  progress.stripeDiscovery={...progress.stripeDiscovery,livemode,clocksComplete:livemode||progress.stripeDiscovery.clocksComplete}
  const persist=async(next:Progress)=>{await save(next);progress=next}
  while(!progress.stripeDiscovery.clocksComplete) {
    const discovery=progress.stripeDiscovery
    const page=await client.testHelpers.testClocks.list({limit:100,...(discovery.clockCursor?{starting_after:discovery.clockCursor}:{})},await options())
    if(page.object!=="list" || !Array.isArray(page.data) || page.data.length>100 || typeof page.has_more!=="boolean") throw failed()
    const known=new Set(discovery.scans.map(scan=>scan.testClock))
    for(const clock of page.data) {
      if(clock.object!=="test_helpers.test_clock" || !/^clock_[A-Za-z0-9]+$/.test(clock.id) || clock.livemode!==false || known.has(clock.id)) throw failed()
      known.add(clock.id)
    }
    const cursor=page.data.at(-1)?.id??null
    if(page.has_more && (!cursor || cursor===discovery.clockCursor)) throw failed()
    await persist({...progress,stripeDiscovery:{...discovery,clockCursor:cursor,clocksComplete:!page.has_more,
      scans:[...discovery.scans,...page.data.map(clock=>({testClock:clock.id,cursor:null,complete:false}))]}})
  }
  for(let index=0;index<progress.stripeDiscovery.scans.length;index++) {
    while(!progress.stripeDiscovery.scans[index].complete) {
      const discovery=progress.stripeDiscovery,scan=discovery.scans[index]
      const page=await client.customers.list({limit:100,...(scan.cursor?{starting_after:scan.cursor}:{}),...(scan.testClock?{test_clock:scan.testClock}:{})},await options())
      if(page.object!=="list" || !Array.isArray(page.data) || page.data.length>100 || typeof page.has_more!=="boolean") throw failed()
      const ids=new Set<string>(),customers=[...progress.stripe]
      for(const customer of page.data) {
        if(customer.object!=="customer" || !/^cus_[A-Za-z0-9_]+$/.test(customer.id) || customer.livemode!==livemode || ids.has(customer.id) || customer.id===scan.cursor) throw failed()
        ids.add(customer.id)
        if(customer.metadata.app!=="cyntch") continue
        const householdId=customer.metadata.household_id,action=scopes.get(householdId)
        if(!action) continue
        const known=customers.find(item=>item.customerId===customer.id)
        if(known && known.householdId!==householdId) throw failed()
        if(!known) customers.push({householdId,action,customerId:customer.id,subscriptionId:null})
      }
      const cursor=page.data.at(-1)?.id??null
      if(page.has_more && !cursor) throw failed()
      await persist({stripe:customers,stripeDiscovery:{...discovery,scans:discovery.scans.map((item,i)=>i===index?{...item,cursor,complete:!page.has_more}:item)}})
    }
  }
  await persist({...progress,stripeDiscovery:{...progress.stripeDiscovery,complete:true}})
  return progress
}
