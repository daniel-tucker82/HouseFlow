"use client"

import { useLayoutEffect } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { isCapacitorNativeShellSync } from "@/lib/native-shell-detect"

/**
 * In the Capacitor native shell, managers should not use leader / household management UI.
 * Redirect any /leader/* navigation to the member dashboard with the same query string.
 */
export function NativeShellMemberOnlyRedirect() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryString = searchParams.toString()

  useLayoutEffect(() => {
    if (!pathname?.startsWith("/leader")) return

    const go = (native: boolean) => {
      if (!native) return
      const target = queryString ? `/member/dashboard?${queryString}` : "/member/dashboard"
      router.replace(target)
    }

    go(isCapacitorNativeShellSync())

    let cancelled = false
    void import("@capacitor/core").then(({ Capacitor }) => {
      if (cancelled) return
      go(Capacitor.isNativePlatform())
    })
    return () => {
      cancelled = true
    }
  }, [pathname, queryString, router])

  return null
}
