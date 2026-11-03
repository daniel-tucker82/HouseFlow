import { auth } from "@clerk/nextjs/server"
import { enforceRequestLimit } from "@/lib/usage-controls"
import { EntitlementError } from "@/lib/entitlements"
import { readMobileRuns, RunReadError } from "@/lib/mobile-runs"

export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  const { userId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 })
  try {
    await enforceRequestLimit(userId, "read")
    return Response.json(await readMobileRuns(userId, new URL(request.url).searchParams), { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof RunReadError || error instanceof EntitlementError) return Response.json({ error: error.message }, { status: error.status })
    console.error("[mobile-runs] Unable to read runs", { error })
    return Response.json({ error: "Unable to load your runs. Please try again." }, { status: 503 })
  }
}
