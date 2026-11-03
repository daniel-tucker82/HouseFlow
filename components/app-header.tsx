"use client"

import { UserButton } from "@clerk/nextjs"
import { LayoutDashboard, Settings, Users } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import { Brand } from "@/components/brand"
import { NotificationBell } from "@/components/notification-bell"
import { isCapacitorNativeShellSync } from "@/lib/native-shell-detect"
import { cn } from "@/lib/utils"

export function AppHeader({
  className,
  lockViewSwitch = false,
  canAccessManagement = true,
}: {
  className?: string
  lockViewSwitch?: boolean
  canAccessManagement?: boolean
}) {
  const [isMounted, setIsMounted] = useState(false)
  const [nativeMemberShell, setNativeMemberShell] = useState(isCapacitorNativeShellSync)
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const selectValue = nativeMemberShell || pathname?.startsWith("/member") ? "member" : "management"
  const canSwitch = canAccessManagement && !nativeMemberShell && !(lockViewSwitch && selectValue === "member")
  const viewHref = (view: string) => {
    const target = view === "member" || !canSwitch ? "/member/dashboard" : "/leader/dashboard"
    const params = new URLSearchParams()
    for (const key of ["household", "routine", "occurrence", "members", "editableMembers"]) {
      const value = searchParams.get(key)
      if (value) params.set(key, value)
    }
    return params.size ? `${target}?${params.toString()}` : target
  }
  useEffect(() => {
    setIsMounted(true)
  }, [])
  useEffect(() => {
    void import("@capacitor/core").then(({ Capacitor }) => setNativeMemberShell(Capacitor.isNativePlatform()))
  }, [])

  return (
    <header
      className={cn(
        "flex h-[var(--app-header-height)] shrink-0 items-center gap-4 border-b border-border bg-card px-4 sm:gap-8 sm:px-6",
        className,
      )}
    >
      <Link
        href={pathname?.startsWith("/join") ? "/app" : viewHref(selectValue)}
        aria-label="Cyntch dashboard"
        className="shrink-0"
      >
        <Brand />
      </Link>
      <nav aria-label="Application views" className="hidden h-full items-center gap-1 sm:flex">
        {canSwitch && (
          <Link
            href={viewHref("management")}
            aria-current={selectValue === "management" ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors",
              selectValue === "management"
                ? "bg-primary/8 text-primary"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            <LayoutDashboard className="size-4" />
            Plan & manage
          </Link>
        )}
        <Link
          href={viewHref("member")}
          aria-current={selectValue === "member" ? "page" : undefined}
          className={cn(
            "flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors",
            selectValue === "member" ? "bg-primary/8 text-primary" : "text-muted-foreground hover:bg-muted",
          )}
        >
          <Users className="size-4" />
          Family board
        </Link>
      </nav>
      <select
        aria-label="Switch application view"
        value={selectValue}
        disabled={!canSwitch}
        onChange={(event) => router.push(viewHref(event.target.value))}
        className="min-w-0 flex-1 rounded-lg border bg-background px-2 py-2.5 text-xs sm:hidden"
      >
        {canSwitch && <option value="management">Plan & manage</option>}
        <option value="member">Family board</option>
      </select>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <NotificationBell />
        <span className="hidden h-6 w-px bg-border sm:block" />
        {isMounted ? (
          <UserButton appearance={{ elements: { avatarBox: "size-8 ring-2 ring-white shadow-sm" } }}>
            <UserButton.MenuItems>
              <UserButton.Link
                label="Notification settings"
                labelIcon={<Settings className="size-4" />}
                href="/settings/notifications"
              />
            </UserButton.MenuItems>
          </UserButton>
        ) : (
          <div aria-hidden className="size-8 rounded-full bg-muted" />
        )}
      </div>
    </header>
  )
}
