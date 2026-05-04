"use client"

import Link from "next/link"
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
        <Link className="w-fit underline text-foreground" href="/auth/login">
          Switch account
        </Link>
      </div>
    )
  }

  return (
    <div className="flex gap-3">
      <Link className="underline" href="/leader/dashboard">
        Create a household
      </Link>
      <Link className="underline" href="/auth/login">
        Switch account
      </Link>
    </div>
  )
}
