"use client"

import { useEffect } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

/**
 * In the Capacitor native shell, managers should not use leader / household management UI.
 * Redirect any /leader/* navigation to the member dashboard with the same query string.
 */
export function NativeShellMemberOnlyRedirect() {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryString = searchParams.toString()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { Capacitor } = await import("@capacitor/core")
      if (!Capacitor.isNativePlatform()) return
      if (!pathname?.startsWith("/leader")) return
      if (cancelled) return
      const target = queryString ? `/member/dashboard?${queryString}` : "/member/dashboard"
      router.replace(target)
    })()
    return () => {
      cancelled = true
    }
  }, [pathname, queryString, router])

  return null
}
