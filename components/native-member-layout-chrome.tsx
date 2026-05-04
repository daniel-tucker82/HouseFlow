"use client"

import { Suspense, useLayoutEffect, useState } from "react"
import { AppHeader } from "@/components/app-header"
import { isCapacitorNativeShellSync } from "@/lib/native-shell-detect"

export function NativeMemberLayoutChrome({
  children,
  lockViewSwitch,
  canAccessManagement,
}: {
  children: React.ReactNode
  lockViewSwitch: boolean
  canAccessManagement: boolean
}) {
  const [hideAppChrome, setHideAppChrome] = useState(isCapacitorNativeShellSync)

  useLayoutEffect(() => {
    void import("@capacitor/core").then(({ Capacitor }) => {
      setHideAppChrome(Capacitor.isNativePlatform())
    })
  }, [])

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {!hideAppChrome ? (
        <Suspense fallback={<div className="h-[var(--app-header-height)] shrink-0 border-b border-border/70 bg-card/90" />}>
          <AppHeader lockViewSwitch={lockViewSwitch} canAccessManagement={canAccessManagement} />
        </Suspense>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
    </div>
  )
}
