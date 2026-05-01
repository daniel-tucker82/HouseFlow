"use client"

import { Bell } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { createPortal } from "react-dom"

type NotificationItem = {
  id: string
  title: string
  body: string
  is_read: boolean
  created_at: string
  url?: string | null
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [toast, setToast] = useState<NotificationItem | null>(null)
  const [panelPosition, setPanelPosition] = useState({ top: 0, right: 0 })
  const seenUnreadIds = useRef<Set<string>>(new Set())
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  /** Portaled panel lives outside `rootRef`; needed so outside-click does not unmount before button clicks fire. */
  const panelRef = useRef<HTMLDivElement | null>(null)
  const searchParams = useSearchParams()
  const router = useRouter()
  const isBrowser = typeof window !== "undefined"

  useEffect(() => {
    if (!open) return
    const updatePosition = () => {
      if (!triggerRef.current) return
      const rect = triggerRef.current.getBoundingClientRect()
      setPanelPosition({
        top: rect.bottom + 8,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }
    updatePosition()
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)
    return () => {
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (rootRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("keydown", onEscape)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("keydown", onEscape)
    }
  }, [open])

  useEffect(() => {
    let cancelled = false
    const householdId = searchParams.get("household")
    const query = householdId ? `?householdId=${encodeURIComponent(householdId)}&limit=20` : "?limit=20"

    const fetchNotifications = async () => {
      const response = await fetch(`/api/notifications/list${query}`, { cache: "no-store" })
      if (!response.ok) return
      const payload = (await response.json()) as { notifications: NotificationItem[]; unreadCount: number }
      if (cancelled) return
      setNotifications(payload.notifications ?? [])
      setUnreadCount(payload.unreadCount ?? 0)
      const unread = (payload.notifications ?? []).filter((item) => !item.is_read)
      const nextUnreadIds = new Set(unread.map((item) => item.id))
      for (const item of unread) {
        if (!seenUnreadIds.current.has(item.id)) {
          setToast(item)
          break
        }
      }
      seenUnreadIds.current = nextUnreadIds
    }

    void fetchNotifications()
    const intervalId = window.setInterval(() => {
      void fetchNotifications()
    }, 15000)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [searchParams])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 3500)
    return () => window.clearTimeout(id)
  }, [toast])

  const markRead = async (notificationId: string, url?: string | null) => {
    await fetch("/api/notifications/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notificationId }),
    })
    setNotifications((prev) => prev.filter((item) => item.id !== notificationId))
    setUnreadCount((prev) => Math.max(0, prev - 1))
    setOpen(false)
    if (url) router.push(url)
  }

  const markAllRead = async () => {
    const householdId = searchParams.get("household")
    const response = await fetch("/api/notifications/mark-all-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ householdId: householdId ?? null }),
    })
    if (!response.ok) return
    setNotifications((prev) => prev.map((item) => ({ ...item, is_read: true })))
    setUnreadCount(0)
    seenUnreadIds.current = new Set()
  }

  const deleteAllNotifications = async () => {
    const householdId = searchParams.get("household")
    const response = await fetch("/api/notifications/delete-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ householdId: householdId ?? null }),
    })
    if (!response.ok) return
    setNotifications([])
    setUnreadCount(0)
    seenUnreadIds.current = new Set()
  }

  useEffect(() => {
    if (!open) return
    void markAllRead()
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md border border-input bg-background hover:bg-muted"
        aria-label="Open notifications"
      >
        <Bell className="size-4" />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {isBrowser && open
        ? createPortal(
            <div
              ref={panelRef}
              className="fixed z-[400] w-80 rounded-lg border border-zinc-200 bg-white p-2 opacity-100 shadow-xl isolate dark:border-zinc-700 dark:bg-zinc-900"
              style={{ top: panelPosition.top, right: panelPosition.right }}
            >
          <div className="mb-2 flex items-center justify-between px-1">
            <p className="text-sm font-medium">Notifications</p>
            <button type="button" onClick={() => void deleteAllNotifications()} className="text-xs text-muted-foreground hover:underline">
              Delete all notifications
            </button>
          </div>
          <ul className="max-h-80 space-y-1 overflow-auto">
            {notifications.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => void markRead(item.id, item.url)}
                  className={`w-full rounded-md border px-2 py-1.5 text-left ${item.is_read ? "bg-muted/50" : "bg-background"}`}
                >
                  <p className="text-xs font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">{item.body}</p>
                </button>
              </li>
            ))}
            {notifications.length === 0 ? <li className="px-2 py-4 text-center text-xs text-muted-foreground">No notifications yet.</li> : null}
          </ul>
            </div>,
            document.body,
          )
        : null}

      {isBrowser && toast
        ? createPortal(
            <div className="fixed right-4 top-[calc(var(--app-header-height)+0.75rem)] z-[420] max-w-xs rounded-lg border border-zinc-200 bg-white p-3 opacity-100 shadow-xl isolate dark:border-zinc-700 dark:bg-zinc-900">
          <p className="text-xs font-semibold">{toast.title}</p>
          <p className="text-xs text-muted-foreground">{toast.body}</p>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
