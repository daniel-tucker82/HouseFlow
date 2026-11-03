import { auth } from "@clerk/nextjs/server"

export const dynamic = "force-dynamic"

export async function GET() {
  const { userId } = await auth()
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 })
  return Response.json({ serverTimeMs: Date.now() }, { headers: { "Cache-Control": "no-store" } })
}
