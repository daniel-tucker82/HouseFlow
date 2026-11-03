import { POST as flowPost } from "@/app/api/leader/flow/route"

/** Use the same transaction, permissions and business rules as web completions. */
export async function POST(request: Request) {
  let body: Record<string, unknown>
  try { body = await request.clone().json() } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }) }
  if (!body || body.action !== "setOccurrenceTaskCompleted" || !body.clientOperation) {
    return Response.json({ error: "A versioned completion operation is required" }, { status: 400 })
  }
  return flowPost(request)
}
