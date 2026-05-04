"use client"

import { UserButton } from "@clerk/nextjs"
import { Search, Settings, Workflow } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { FormEvent, useEffect, useMemo, useState } from "react"

import { NotificationBell } from "@/components/notification-bell"
import { isCapacitorNativeShellSync } from "@/lib/native-shell-detect"
import { cn } from "@/lib/utils"

function buildAppHomeHref(
  pathname: string | null,
  nativeMemberShell: boolean,
  searchParams: { get: (key: string) => string | null },
) {
  const memberQuery = () => {
    const p = new URLSearchParams()
    const h = searchParams.get("household")
    const m = searchParams.get("members")
    const e = searchParams.get("editableMembers")
    if (h) p.set("household", h)
    if (m) p.set("members", m)
    if (e) p.set("editableMembers", e)
    const q = p.toString()
    return q ? `/member/dashboard?${q}` : "/member/dashboard"
  }
  if (pathname?.startsWith("/member")) return memberQuery()
  if (pathname?.startsWith("/join")) return "/"
  if (nativeMemberShell) return memberQuery()
  const p = new URLSearchParams()
  const h = searchParams.get("household")
  const r = searchParams.get("routine")
  const o = searchParams.get("occurrence")
  const m = searchParams.get("members")
  const e = searchParams.get("editableMembers")
  if (h) p.set("household", h)
  if (r) p.set("routine", r)
  if (o) p.set("occurrence", o)
  if (m) p.set("members", m)
  if (e) p.set("editableMembers", e)
  const q = p.toString()
  return q ? `/leader/dashboard?${q}` : "/leader/dashboard"
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
  const [nativeMemberShell, setNativeMemberShell] = useState(isCapacitorNativeShellSync)
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const effectiveCanAccessManagement = canAccessManagement && !nativeMemberShell
  const homeHref = useMemo(
    () => buildAppHomeHref(pathname, nativeMemberShell, searchParams),
    [pathname, nativeMemberShell, searchParams],
  )
  const currentHousehold = searchParams.get("household")
  const currentRoutine = searchParams.get("routine")
  const currentOccurrence = searchParams.get("occurrence")
  const currentMembers = searchParams.get("members")
  const currentEditableMembers = searchParams.get("editableMembers")
  const viewMode = pathname?.startsWith("/member") ? "member" : "management"
  const selectValue = nativeMemberShell ? "member" : viewMode

  const onSearchSubmit = (e: FormEvent) => {
    e.preventDefault()
  }

  useEffect(() => {
    setIsMounted(true)
  }, [])

  useEffect(() => {
    void import("@capacitor/core").then(({ Capacitor }) => {
      setNativeMemberShell(Capacitor.isNativePlatform())
    })
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
        <span className="truncate text-[15px] font-semibold tracking-tight">Cyntch</span>
      </Link>
      <label className="shrink-0">
        <span className="sr-only">Switch application view</span>
        <select
          aria-label="Switch application view"
          value={selectValue}
          disabled={lockViewSwitch && selectValue === "member"}
          onChange={(event) => {
            const target =
              event.target.value === "member" || !effectiveCanAccessManagement ? "/member/dashboard" : "/leader/dashboard"
            const params = new URLSearchParams()
            if (currentHousehold) params.set("household", currentHousehold)
            if (currentRoutine) params.set("routine", currentRoutine)
            if (currentOccurrence) params.set("occurrence", currentOccurrence)
            if (currentMembers) params.set("members", currentMembers)
            if (currentEditableMembers) params.set("editableMembers", currentEditableMembers)
            const query = params.toString()
            router.push(query ? `${target}?${query}` : target)
          }}
          className="h-9 rounded-lg border border-input bg-background px-2.5 text-sm shadow-inner outline-none transition-[box-shadow,background-color] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35"
        >
          {effectiveCanAccessManagement && !(lockViewSwitch && selectValue === "member") ? (
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
