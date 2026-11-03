"use client"

import Link from "next/link"
import { SignOutButton } from "@clerk/nextjs"
export function NoHouseholdActions() {
  return (
    <div className="flex flex-wrap items-center gap-5">
      <Link className="marketing-button" href="/leader/dashboard">
        Create a household
      </Link>
      <SignOutButton redirectUrl="/auth/login"><button type="button" className="text-sm text-muted-foreground underline underline-offset-4">Switch account</button></SignOutButton>
    </div>
  )
}
