import { NextResponse } from "next/server"
import { getWebPushPublicKey, isWebPushEnabled } from "@/lib/push"

export async function GET() {
  return NextResponse.json({
    enabled: isWebPushEnabled(),
    publicKey: getWebPushPublicKey(),
  })
}
