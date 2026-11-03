import { auth } from "@clerk/nextjs/server"
import { NextResponse } from "next/server"
import { EntitlementError, withHouseholdWrite } from "@/lib/entitlements"
import { billingOrigin } from "@/lib/stripe-billing"

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({error:"Unauthorized"}, {status:401})
  try {
    if (request.headers.get("origin") !== billingOrigin()) throw new EntitlementError("Invalid origin")
    const body = await request.json()
    const householdId = String(body?.householdId ?? "")
    const routineId = String(body?.routineId ?? "")
    if (![householdId,routineId].every(id => /^[0-9a-f-]{36}$/i.test(id))) throw new EntitlementError("Invalid household or template",400)
    await withHouseholdWrite(householdId,userId,async client => {
      const routine = await client.query("select id from routines where id = $1::uuid and household_id = $2::uuid", [routineId,householdId])
      if (!routine.rowCount) throw new EntitlementError("Template not found",404)
      const active = await client.query("select 1 from routine_occurrences where household_id = $1::uuid and status = 'active' and routine_id is distinct from $2::uuid limit 1",[householdId,routineId])
      if (active.rowCount) throw new EntitlementError("Finish your existing active runs before switching free templates.",409)
      await client.query(`insert into household_billing (household_id,free_routine_id) values ($1::uuid,$2::uuid)
        on conflict (household_id) do update set free_routine_id = excluded.free_routine_id, updated_at = now()`,[householdId,routineId])
    })
    return NextResponse.json({ok:true})
  } catch(error) {
    return NextResponse.json({error:error instanceof EntitlementError ? error.message : "Unable to select template"}, {status:error instanceof EntitlementError ? error.status : 400})
  }
}
