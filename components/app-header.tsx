"use client"

import { UserButton } from "@clerk/nextjs"
import { Search, Settings, Workflow } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { FormEvent, useEffect, useState } from "react"

import { NotificationBell } from "@/components/notification-bell"
import { cn } from "@/lib/utils"

function homeHrefForPath(pathname: string | null) {
  if (pathname?.startsWith("/member")) return "/member/dashboard"
  if (pathname?.startsWith("/join")) return "/"
  return "/leader/dashboard"
}

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
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const homeHref = homeHrefForPath(pathname)
  const currentHousehold = searchParams.get("household")
  const currentRoutine = searchParams.get("routine")
  const currentOccurrence = searchParams.get("occurrence")
  const viewMode = pathname?.startsWith("/member") ? "member" : "management"

  const onSearchSubmit = (e: FormEvent) => {
    e.preventDefault()
  }

  useEffect(() => {
    setIsMounted(true)
  }, [])

  return (
    <header
      className={cn(
        "flex h-[var(--app-header-height)] shrink-0 items-center gap-3 border-b border-border/70 bg-card/90 px-3 shadow-sm backdrop-blur-md sm:px-4",
        className,
      )}
    >
      <Link
        href={homeHref}
        className="flex min-w-0 shrink-0 items-center gap-2 rounded-lg py-1.5 pr-2 text-foreground transition-colors hover:bg-muted/80"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm ring-1 ring-black/5">
          <Workflow className="size-4" aria-hidden />
        </span>
        <span className="truncate text-[15px] font-semibold tracking-tight">Houseflow</span>
      </Link>
      <label className="shrink-0">
        <span className="sr-only">Switch application view</span>
        <select
          aria-label="Switch application view"
          value={viewMode}
          disabled={lockViewSwitch && viewMode === "member"}
          onChange={(event) => {
            const target =
              event.target.value === "member" || !canAccessManagement ? "/member/dashboard" : "/leader/dashboard"
            const params = new URLSearchParams()
            if (currentHousehold) params.set("household", currentHousehold)
            if (currentRoutine) params.set("routine", currentRoutine)
            if (currentOccurrence) params.set("occurrence", currentOccurrence)
            const query = params.toString()
            router.push(query ? `${target}?${query}` : target)
          }}
          className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm shadow-inner outline-none transition-[box-shadow,background-color] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35"
        >
          {canAccessManagement && !(lockViewSwitch && viewMode === "member") ? (
            <option value="management">Household management</option>
          ) : null}
          <option value="member">Member view</option>
        </select>
      </label>

      <form
        onSubmit={onSearchSubmit}
        className="mx-auto hidden min-w-0 max-w-md flex-1 sm:block"
        role="search"
        aria-label="Search tasks and routines"
      >
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            name="q"
            placeholder="Search tasks and routines…"
            title="Search will be available in a future update"
            className="h-9 w-full rounded-lg border border-input bg-background py-2 pr-3 pl-9 text-sm shadow-inner outline-none transition-[box-shadow,background-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35"
          />
        </div>
      </form>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <form onSubmit={onSearchSubmit} className="sm:hidden" aria-label="Search (coming soon)">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search…"
              title="Search will be available in a future update"
              className="h-8 w-[min(11rem,40vw)] rounded-md border border-input bg-background py-1.5 pr-2 pl-8 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
            />
          </div>
        </form>
        <NotificationBell />
        {isMounted ? (
          <UserButton
            appearance={{
              elements: {
                avatarBox: "size-8 ring-1 ring-border shadow-sm",
              },
            }}
          >
            <UserButton.MenuItems>
              <UserButton.Link
                label="Notification settings"
                labelIcon={<Settings className="size-4" />}
                href="/settings/notifications"
              />
            </UserButton.MenuItems>
          </UserButton>
        ) : (
          <div aria-hidden className="size-8 rounded-full bg-muted ring-1 ring-border" />
        )}
      </div>
    </header>
  )
}
