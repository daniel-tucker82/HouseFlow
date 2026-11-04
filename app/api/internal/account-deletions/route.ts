import { timingSafeEqual } from "node:crypto"
import { runAccountDeletions } from "@/lib/run-account-deletions"

export const dynamic="force-dynamic"
export const runtime="nodejs"
export const maxDuration=30
const headers={"Cache-Control":"private, no-store"}

export async function GET(request: Request) {
  const secret=process.env.CRON_SECRET?.trim()
  if(!secret) return Response.json({error:"Cron is not configured"},{status:503,headers})
  const actual=Buffer.from(request.headers.get("authorization")??""),expected=Buffer.from(`Bearer ${secret}`)
  if(actual.length!==expected.length || !timingSafeEqual(actual,expected)) return Response.json({error:"Unauthorized"},{status:401,headers})
  const result=await runAccountDeletions()
  return Response.json(result,{status:result.ok?200:503,headers})
}
