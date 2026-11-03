"use client"

import Link from "next/link"
import { SignOutButton } from "@clerk/nextjs"
import { useEffect, useState } from "react"

export function NoHouseholdNativeActions() {
  const [isNative, setIsNative] = useState(false)

  useEffect(() => {
    void import("@capacitor/core").then(({ Capacitor }) => {
      setIsNative(Capacitor.isNativePlatform())
    })
  }, [])

  if (isNative) {
    return (
      <div className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>
          You’re signed in, but you’re not part of a household yet. Creating a household is only available in the web
          app.
        </p>
        <p>
          Open Cyntch in a desktop or mobile browser to create a household, then return here after you’ve been invited
          or added.
        </p>
        <SignOutButton redirectUrl="/auth/login"><button type="button" className="w-fit underline text-foreground">Switch account</button></SignOutButton>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-5">
      <Link className="marketing-button" href="/leader/dashboard">
        Create a household
      </Link>
      <SignOutButton redirectUrl="/auth/login"><button type="button" className="text-sm text-muted-foreground underline underline-offset-4">Switch account</button></SignOutButton>
    </div>
  )
}
