"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { LogOut, Menu, Settings } from "lucide-react"
import { UserButton, useClerk } from "@clerk/nextjs"
import { NotificationBell } from "@/components/notification-bell"
import { cn } from "@/lib/utils"
import type { EffectiveRole } from "@/lib/household-authz"

const FAB_SIZE = 56
const FAB_PAD = 12
const FAB_POS_KEY = "cyntch_member_fab_pos"

function clampFabPosition(left: number, top: number) {
  if (typeof window === "undefined") return { left, top }
  const maxLeft = window.innerWidth - FAB_SIZE - FAB_PAD
  const maxTop = window.innerHeight - FAB_SIZE - FAB_PAD
  return {
    left: Math.min(Math.max(FAB_PAD, left), maxLeft),
    top: Math.min(Math.max(FAB_PAD, top), maxTop),
  }
}

function defaultFabPosition() {
  if (typeof window === "undefined") return { left: 0, top: 0 }
  return clampFabPosition(window.innerWidth - FAB_SIZE - FAB_PAD, window.innerHeight - FAB_SIZE - FAB_PAD)
}

type Member = {
  id: string
  name: string
  avatar_url: string | null
  token_color: string | null
  role: "manager" | "supervisor" | "member" | "leader"
}

type Membership = {
  role: "manager" | "supervisor" | "member" | "leader"
  household: {
    id: string
    name: string
    leader_id: string
  }
}

type Task = {
  id: string
  occurrence_id: string
  occurrence_title: string | null
  occurrence_kind: "routine" | "manual"
  title: string
  description: string | null
  is_reward: boolean
  status: "locked" | "unlocked" | "completed"
  assignee_ids: string[]
  created_at: string
  lock_type: "none" | "prerequisite" | "time"
  blocking_task_id: string | null
  blocking_task_title: string | null
  blocking_task_assignee_ids: string[]
  unlock_at: string | null
  expires_at: string | null
}

type Props = {
  memberships: Membership[]
  selectedHouseholdId: string
  selectedMemberIds: string[]
  editableMemberIds: string[]
  viewerRole: EffectiveRole
  viewerUserId: string
  leaderId: string
  members: Member[]
  tasks: Task[]
  kioskActive: boolean
}

function lockMessage(
  task: Task,
  options?: { currentMemberId?: string; memberNameById?: Map<string, string>; hasHydrated?: boolean },
) {
  if (task.lock_type === "prerequisite" && task.blocking_task_title) {
    const currentMemberId = options?.currentMemberId
    const memberNameById = options?.memberNameById
    if (
      currentMemberId &&
      task.blocking_task_assignee_ids.length > 0 &&
      !task.blocking_task_assignee_ids.includes(currentMemberId)
    ) {
      const blockingMemberName =
        memberNameById?.get(task.blocking_task_assignee_ids[0]) ?? "Another household member"
      return (
        <>
          locked due to prerequisite - {blockingMemberName} must complete <strong>{task.blocking_task_title}</strong> to
          unlock this task.
        </>
      )
    }
    return (
      <>
        locked due to prerequisite - complete <strong>{task.blocking_task_title}</strong> to unlock
      </>
    )
  }
  if (task.lock_type === "time" && task.unlock_at) {
    if (!options?.hasHydrated) {
      return "task will unlock soon"
    }
    const unlockAt = new Date(task.unlock_at)
    const now = new Date()
    const unlockDay = new Date(unlockAt)
    unlockDay.setHours(0, 0, 0, 0)
    const nowDay = new Date(now)
    nowDay.setHours(0, 0, 0, 0)
    const dayDelta = Math.round((unlockDay.getTime() - nowDay.getTime()) / 86400000)
    const dayText =
      dayDelta === 0
        ? "today"
        : dayDelta === 1
          ? "tomorrow"
          : `on ${new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(unlockAt)}`
    const unlockTime = new Intl.DateTimeFormat("en-AU", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(unlockAt)
    return `task will unlock at ${unlockTime}, ${dayText}`
  }
  return "task will unlock at [time], [today / tomorrow / on date]"
}

export function MemberDashboardClient({
  memberships,
  selectedHouseholdId,
  selectedMemberIds,
  editableMemberIds,
  viewerRole,
  viewerUserId,
  leaderId,
  members,
  tasks,
  kioskActive,
}: Props) {
  const router = useRouter()
  const { signOut } = useClerk()
  const [localTasks, setLocalTasks] = useState<Task[]>(tasks)
  const [activeTask, setActiveTask] = useState<Task | null>(null)
  const [isToggling, setIsToggling] = useState<string | null>(null)
  const [selectorsOpen, setSelectorsOpen] = useState(false)
  const [isKioskMode, setIsKioskMode] = useState(kioskActive)
  const [isKioskPending, setIsKioskPending] = useState(false)
  const [roleUpdatingMemberId, setRoleUpdatingMemberId] = useState<string | null>(null)
  const [hasHydrated, setHasHydrated] = useState(false)
  const [isNativeShell, setIsNativeShell] = useState(false)
  const [fabPos, setFabPos] = useState<{ left: number; top: number } | null>(null)
  const refreshOccurrenceStatusesRef = useRef<(occurrenceId: string) => Promise<void>>(async () => {})
  const fabDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originLeft: number
    originTop: number
  } | null>(null)
  const fabIsDraggingRef = useRef(false)

  useEffect(() => {
    setHasHydrated(true)
  }, [])

  useLayoutEffect(() => {
    void import("@capacitor/core").then(({ Capacitor }) => {
      const native = Capacitor.isNativePlatform()
      setIsNativeShell(native)
      if (!native || typeof window === "undefined") return
      try {
        const raw = window.localStorage.getItem(FAB_POS_KEY)
        if (raw) {
          const p = JSON.parse(raw) as { left?: number; top?: number }
          if (typeof p.left === "number" && typeof p.top === "number") {
            const c = clampFabPosition(p.left, p.top)
            setFabPos(c)
            return
          }
        }
      } catch {
        /* ignore */
      }
      setFabPos(defaultFabPosition())
    })
  }, [])

  useEffect(() => {
    if (!isNativeShell || fabPos === null) return
    const onResize = () => setFabPos((p) => (p ? clampFabPosition(p.left, p.top) : p))
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [isNativeShell, fabPos])

  useEffect(() => {
    if (!selectorsOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectorsOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [selectorsOpen])

  useEffect(() => {
    setLocalTasks(tasks)
  }, [tasks])

  useEffect(() => {
    if (isKioskMode) setSelectorsOpen(false)
  }, [isKioskMode])

  // Leader flow runs materializeDueRecurrences on GET /api/leader/flow; member tasks are SSR-only
  // unless we ping that route so routine occurrences catch up after the scheduled time (cron is daily on Hobby).
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
    const qs = new URLSearchParams({ householdId: selectedHouseholdId, timezone: tz })
    let cancelled = false
    void (async () => {
      const res = await fetch(`/api/leader/flow?${qs.toString()}`)
      if (cancelled || !res.ok) return
      router.refresh()
    })()
    return () => {
      cancelled = true
    }
  }, [router, selectedHouseholdId])

  const memberNameById = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members])
  const selectedMemberSet = useMemo(() => new Set(selectedMemberIds), [selectedMemberIds])
  const editableMemberSet = useMemo(() => {
    if (viewerRole !== "member") return new Set(editableMemberIds)
    return new Set(selectedMemberIds.filter((id) => id === viewerUserId))
  }, [editableMemberIds, selectedMemberIds, viewerRole, viewerUserId])
  const effectiveEditableMemberIds = useMemo(() => [...editableMemberSet], [editableMemberSet])
  const canConfigureView = viewerRole === "manager" || viewerRole === "supervisor"
  const canActivateKiosk = viewerRole === "manager"
  const selectedMembers = useMemo(
    () => members.filter((member) => selectedMemberSet.has(member.id)),
    [members, selectedMemberSet],
  )
  const orderedTasks = useMemo(() => {
    const byId = new Map(localTasks.map((task) => [task.id, task]))
    const createdAtMs = (task: Task) => new Date(task.created_at).getTime()
    const statusRank = (status: Task["status"]) =>
      status === "unlocked" ? 0 : status === "completed" ? 1 : 2

    const lockDepthCache = new Map<string, number>()
    const lockDepth = (task: Task, seen: Set<string> = new Set()): number => {
      if (task.status !== "locked") return 0
      if (lockDepthCache.has(task.id)) return lockDepthCache.get(task.id) ?? 0
      if (!task.blocking_task_id || seen.has(task.id)) return 0
      seen.add(task.id)
      const blocker = byId.get(task.blocking_task_id)
      const depth = blocker && blocker.status === "locked" ? 1 + lockDepth(blocker, seen) : 1
      lockDepthCache.set(task.id, depth)
      return depth
    }

    return [...localTasks].sort((a, b) => {
      const rankDiff = statusRank(a.status) - statusRank(b.status)
      if (rankDiff !== 0) return rankDiff
      if (a.status === "locked" && b.status === "locked") {
        const depthDiff = lockDepth(a) - lockDepth(b)
        if (depthDiff !== 0) return depthDiff
      }
      return createdAtMs(a) - createdAtMs(b)
    })
  }, [localTasks])

  const tasksByMember = useMemo(() => {
    const grouped = new Map<string, Task[]>()
    for (const member of members) grouped.set(member.id, [])
    for (const task of orderedTasks) {
      if (task.assignee_ids.length === 0) {
        grouped.get(leaderId)?.push(task)
        continue
      }
      for (const assigneeId of task.assignee_ids) grouped.get(assigneeId)?.push(task)
    }
    return grouped
  }, [leaderId, members, orderedTasks])

  useEffect(() => {
    const hasTimeEligibleLockedTask = localTasks.some(
      (task) => task.status === "locked" && task.lock_type === "time" && Boolean(task.unlock_at),
    )
    const hasExpiryCandidate = localTasks.some(
      (task) => Boolean(task.expires_at) && task.status !== "completed",
    )
    if (!hasTimeEligibleLockedTask && !hasExpiryCandidate) return

    const candidateInstantsMs = localTasks
      .flatMap((task) => {
        if (task.status === "completed") return []
        const values: number[] = []
        if (task.expires_at) {
          const expiresMs = new Date(task.expires_at).getTime()
          if (!Number.isNaN(expiresMs)) values.push(expiresMs)
        }
        if (task.status === "locked" && task.unlock_at) {
          const unlockMs = new Date(task.unlock_at).getTime()
          if (!Number.isNaN(unlockMs)) values.push(unlockMs)
        }
        return values
      })

    let timeoutId: number | null = null
    let cancelled = false
    const scheduleNextPoll = () => {
      if (cancelled) return
      const now = new Date()
      const nowMs = now.getTime()
      const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 10
      const msUntilNearestInstant = candidateInstantsMs
        .map((instantMs) => instantMs - nowMs + 25)
        .filter((delta) => delta > 0)
        .reduce((min, delta) => Math.min(min, delta), Number.POSITIVE_INFINITY)
      const nextDelay =
        Number.isFinite(msUntilNearestInstant)
          ? Math.max(10, Math.min(msUntilNextMinute, msUntilNearestInstant))
          : Math.max(10, msUntilNextMinute)
      timeoutId = window.setTimeout(() => {
        const occurrenceIds = [...new Set(localTasks.map((task) => task.occurrence_id).filter(Boolean))]
        void Promise.all(occurrenceIds.map((occurrenceId) => refreshOccurrenceStatusesRef.current(occurrenceId)))
        scheduleNextPoll()
      }, nextDelay)
    }
    scheduleNextPoll()

    return () => {
      cancelled = true
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }
  }, [localTasks])

  const buildDashboardHref = (householdId: string, memberIds: string[], editableIds: string[]) => {
    const params = new URLSearchParams()
    params.set("household", householdId)
    params.set("members", memberIds.join(","))
    params.set("editableMembers", editableIds.join(","))
    return `/member/dashboard?${params.toString()}`
  }
  const toggleMemberSelection = (memberId: string) => {
    if (selectedMemberSet.has(memberId)) {
      if (selectedMemberIds.length <= 1) return selectedMemberIds
      return selectedMemberIds.filter((id) => id !== memberId)
    }
    return [...selectedMemberIds, memberId]
  }
  const toggleEditableSelection = (memberId: string) => {
    if (editableMemberSet.has(memberId)) {
      if (editableMemberIds.length <= 1) return editableMemberIds
      return editableMemberIds.filter((id) => id !== memberId)
    }
    if (!selectedMemberSet.has(memberId)) return editableMemberIds
    return [...editableMemberIds, memberId]
  }

  const refreshOccurrenceStatuses = useCallback(async (occurrenceId: string) => {
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "listOccurrenceStatuses",
        householdId: selectedHouseholdId,
        occurrenceId,
      }),
    })
    if (!response.ok) return
    const json = (await response.json().catch(() => null)) as
      | { occurrenceTaskStatuses?: Array<{ task_id: string; status: string }> }
      | null
    if (!json?.occurrenceTaskStatuses?.length) return
    const statusByTaskId = new Map(
      json.occurrenceTaskStatuses.map((row) => [String(row.task_id), String(row.status)]),
    )
    setLocalTasks((prev) =>
      prev.map((row) => {
        const incoming = statusByTaskId.get(row.id)
        if (!incoming) return row
        if (incoming === "locked" || incoming === "unlocked" || incoming === "completed") {
          return { ...row, status: incoming }
        }
        return row
      }),
    )
  }, [selectedHouseholdId])
  refreshOccurrenceStatusesRef.current = refreshOccurrenceStatuses

  const toggleTaskCompleted = async (task: Task, actingMemberId: string) => {
    if (task.status === "locked" || isToggling || !editableMemberSet.has(actingMemberId)) return
    setIsToggling(task.id)
    const nextStatus: Task["status"] = task.status === "completed" ? "unlocked" : "completed"
    setLocalTasks((prev) => prev.map((row) => (row.id === task.id ? { ...row, status: nextStatus } : row)))
    try {
      const response = await fetch("/api/leader/flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setOccurrenceTaskCompleted",
          householdId: selectedHouseholdId,
          occurrenceId: task.occurrence_id,
          taskId: task.id,
          completed: task.status !== "completed",
          actorMemberId: actingMemberId,
          editableMemberIds: effectiveEditableMemberIds,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
        }),
      })
      if (!response.ok) {
        setLocalTasks((prev) => prev.map((row) => (row.id === task.id ? { ...row, status: task.status } : row)))
        throw new Error("Failed to update task")
      }
      const json = (await response.json().catch(() => null)) as
        | { occurrenceTaskStatuses?: Array<{ task_id: string; status: string }> }
        | null
      const serverStatuses = json?.occurrenceTaskStatuses ?? []
      const hasServerStatuses = serverStatuses.length > 0
      if (hasServerStatuses) {
        const statusByTaskId = new Map(
          serverStatuses.map((row) => [String(row.task_id), String(row.status)]),
        )
        setLocalTasks((prev) =>
          prev.map((row) => {
            const incoming = statusByTaskId.get(row.id)
            if (!incoming) return row
            if (incoming === "locked" || incoming === "unlocked" || incoming === "completed") {
              return { ...row, status: incoming }
            }
            return row
          }),
        )
      }
      // Avoid a second blocking request when the toggle response already includes recomputed statuses.
      if (!hasServerStatuses) {
        void refreshOccurrenceStatuses(task.occurrence_id)
      }
    } catch (error) {
      console.error(error)
    } finally {
      setIsToggling(null)
    }
  }

  const activateKioskMode = async () => {
    if (isKioskPending) return
    const pin = window.prompt("Set a new kiosk PIN")
    if (!pin) return
    setIsKioskPending(true)
    try {
      const response = await fetch("/api/leader/flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "activateKioskMode",
          householdId: selectedHouseholdId,
          pin,
          visibleMemberIds: selectedMemberIds,
          editableMemberIds,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
        }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null
        window.alert(payload?.error ?? "Unable to enable kiosk mode.")
        return
      }
      setIsKioskMode(true)
      router.refresh()
    } finally {
      setIsKioskPending(false)
    }
  }

  const exitKioskMode = async () => {
    if (isKioskPending) return
    const pin = window.prompt("Enter kiosk PIN to exit")
    if (!pin) return
    setIsKioskPending(true)
    try {
      const response = await fetch("/api/leader/flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "verifyKioskExitPin",
          householdId: selectedHouseholdId,
          pin,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
        }),
      })
      if (!response.ok) {
        window.alert("Incorrect PIN. Kiosk mode remains active.")
        return
      }
      setIsKioskMode(false)
      router.refresh()
    } finally {
      setIsKioskPending(false)
    }
  }

  const forgotKioskPin = async () => {
    if (isKioskPending) return
    const confirmed = window.confirm("Forgot PIN will sign you out. Continue?")
    if (!confirmed) return
    setIsKioskPending(true)
    try {
      const response = await fetch("/api/leader/flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "forgotKioskPinAndSignOut",
          householdId: selectedHouseholdId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
        }),
      })
      if (!response.ok) {
        window.alert("Unable to clear kiosk PIN right now.")
        return
      }
      await signOut({ redirectUrl: "/auth/login" })
    } finally {
      setIsKioskPending(false)
    }
  }

  const updateMemberRole = async (memberId: string, role: "member" | "supervisor") => {
    if (roleUpdatingMemberId) return
    setRoleUpdatingMemberId(memberId)
    try {
      const response = await fetch("/api/leader/flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "updateMemberRole",
          householdId: selectedHouseholdId,
          memberUserId: memberId,
          role,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
        }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null
        window.alert(payload?.error ?? "Unable to update member role.")
        return
      }
      router.refresh()
    } finally {
      setRoleUpdatingMemberId(null)
    }
  }

  const onFabPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!isNativeShell || fabPos === null) return
      if (event.button !== 0) return
      fabIsDraggingRef.current = false
      event.currentTarget.setPointerCapture(event.pointerId)
      fabDragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originLeft: fabPos.left,
        originTop: fabPos.top,
      }
    },
    [fabPos, isNativeShell],
  )

  const onFabPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = fabDragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    const moveDx = event.clientX - drag.startX
    const moveDy = event.clientY - drag.startY
    if (!fabIsDraggingRef.current && moveDx * moveDx + moveDy * moveDy > 64) {
      fabIsDraggingRef.current = true
    }
    if (!fabIsDraggingRef.current) return
    const nextLeft = drag.originLeft + moveDx
    const nextTop = drag.originTop + moveDy
    setFabPos(clampFabPosition(nextLeft, nextTop))
  }, [])

  const onFabPointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = fabDragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    fabDragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    const dragged = fabIsDraggingRef.current
    fabIsDraggingRef.current = false
    if (dragged) {
      setFabPos((p) => {
        if (!p) return p
        const c = clampFabPosition(p.left, p.top)
        try {
          window.localStorage.setItem(FAB_POS_KEY, JSON.stringify(c))
        } catch {
          /* ignore */
        }
        return c
      })
      return
    }
    setSelectorsOpen((open) => !open)
  }, [])

  const onFabPointerCancel = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = fabDragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    fabDragRef.current = null
    fabIsDraggingRef.current = false
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  }, [])

  const TaskRow = ({ task, currentMemberId, isEditable }: { task: Task; currentMemberId?: string; isEditable: boolean }) => (
    <li
      className={`flex min-h-[72px] items-stretch overflow-hidden rounded border ${
        task.status === "locked"
          ? task.is_reward
            ? "border-slate-300 bg-sky-50/60 text-slate-700"
            : "border-zinc-300 bg-zinc-100 text-zinc-500"
          : task.status === "completed"
            ? "border-green-300 bg-green-50 text-zinc-700"
            : task.is_reward
              ? "border-sky-300 bg-sky-50 text-sky-900"
              : ""
      }`}
    >
      <button
        type="button"
        onClick={() => setActiveTask(task)}
        className="flex min-w-0 flex-1 flex-col justify-center p-2 text-left hover:bg-black/5"
      >
        <p className={`truncate font-medium ${task.status === "completed" ? "line-through" : ""}`}>{task.title}</p>
        {task.status === "locked" ? (
          <p className="text-xs">{lockMessage(task, { currentMemberId, memberNameById, hasHydrated })}</p>
        ) : !isEditable ? (
          <p className="text-xs text-muted-foreground">Read only in this view</p>
        ) : task.status === "completed" ? (
          <p className="text-xs text-green-700">Completed (click Undo to revert to incomplete)</p>
        ) : (
          <p className="text-xs text-muted-foreground">Unlocked</p>
        )}
      </button>
      <button
        type="button"
        disabled={task.status === "locked" || isToggling === task.id || !isEditable}
        onClick={(event) => {
          event.stopPropagation()
          if (!currentMemberId) return
          void toggleTaskCompleted(task, currentMemberId)
        }}
        className={`w-14 shrink-0 border-l text-xs font-semibold ${
          task.status === "locked" || !isEditable
            ? task.is_reward
              ? "cursor-not-allowed border-slate-300 bg-slate-200 text-slate-500"
              : "cursor-not-allowed border-zinc-300 bg-zinc-200 text-zinc-400"
            : task.status === "completed"
              ? "border-amber-700 bg-amber-600 text-white hover:bg-amber-700"
              : "border-green-700 bg-green-600 text-white hover:bg-green-700"
        }`}
        aria-label={task.status === "locked" || !isEditable ? "Task not editable" : "Mark task complete"}
      >
        {isToggling === task.id ? "..." : task.status === "completed" ? "Undo" : isEditable ? "Done" : "Lock"}
      </button>
    </li>
  )

  const chipClass =
    "inline-flex max-w-full items-center justify-center truncate rounded border px-1.5 py-0.5 text-[11px] font-medium leading-tight"
  const sectionLabelClass = "mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"

  const selectorsMenuBody = (
    <div className="flex flex-col gap-2.5">
      {isNativeShell && hasHydrated ? (
        <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
          <NotificationBell />
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
        </div>
      ) : null}

      {!isKioskMode ? (
        <>
          {canActivateKiosk ? (
            <section>
              <h3 className={sectionLabelClass}>Kiosk</h3>
              <button
                type="button"
                onClick={() => void activateKioskMode()}
                className="rounded bg-black px-2 py-0.5 text-[11px] font-medium text-white hover:bg-zinc-800"
                disabled={isKioskPending}
              >
                Turn on
              </button>
            </section>
          ) : null}

          <section>
            <h3 className={sectionLabelClass}>Household</h3>
            <div className="grid grid-cols-2 gap-1">
              {memberships.map((membership) => (
                <Link
                  key={membership.household.id}
                  href={buildDashboardHref(membership.household.id, selectedMemberIds, editableMemberIds)}
                  onClick={() => setSelectorsOpen(false)}
                  className={`${chipClass} ${
                    membership.household.id === selectedHouseholdId ? "bg-black text-white" : "bg-background"
                  }`}
                >
                  {membership.household.name}
                </Link>
              ))}
            </div>
          </section>

          <section>
            <h3 className={sectionLabelClass}>Visible members</h3>
            <div className="grid grid-cols-2 gap-1">
              {members.map((member) => (
                <Link
                  key={member.id}
                  href={buildDashboardHref(
                    selectedHouseholdId,
                    toggleMemberSelection(member.id),
                    toggleMemberSelection(member.id).filter((id) => effectiveEditableMemberIds.includes(id)),
                  )}
                  onClick={() => setSelectorsOpen(false)}
                  className={`${chipClass} ${selectedMemberSet.has(member.id) ? "bg-black text-white" : "bg-background"}`}
                >
                  {member.name}
                </Link>
              ))}
            </div>
          </section>

          {canConfigureView ? (
            <section>
              <h3 className={sectionLabelClass}>Editable</h3>
              <div className="grid grid-cols-2 gap-1">
                {selectedMembers.map((member) => (
                  <Link
                    key={`editable:${member.id}`}
                    href={buildDashboardHref(
                      selectedHouseholdId,
                      selectedMemberIds,
                      toggleEditableSelection(member.id),
                    )}
                    onClick={() => setSelectorsOpen(false)}
                    className={`${chipClass} ${editableMemberSet.has(member.id) ? "bg-green-700 text-white" : "bg-background"}`}
                  >
                    {member.name}
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {canActivateKiosk ? (
            <section>
              <h3 className={sectionLabelClass}>Member roles</h3>
              <div className="space-y-1">
                {members.map((member) => {
                  const normalizedRole = member.role === "leader" ? "manager" : member.role
                  const canChangeRole = member.id !== leaderId
                  const nextRole = normalizedRole === "supervisor" ? "member" : "supervisor"
                  return (
                    <div
                      key={`role:${member.id}`}
                      className="flex items-center justify-between gap-1 rounded border border-border/80 px-1.5 py-1 text-[11px]"
                    >
                      <span className="min-w-0 truncate font-medium">
                        {member.name}{" "}
                        <span className="font-normal text-muted-foreground">({normalizedRole})</span>
                      </span>
                      {canChangeRole ? (
                        <button
                          type="button"
                          onClick={() => void updateMemberRole(member.id, nextRole)}
                          className="shrink-0 rounded border px-1 py-0.5 text-[10px] hover:bg-muted"
                          disabled={roleUpdatingMemberId === member.id}
                        >
                          {roleUpdatingMemberId === member.id ? "…" : nextRole === "supervisor" ? "→Sup" : "→Mem"}
                        </button>
                      ) : (
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px]">Mgr</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  )

  const selectorsMenuPortal =
    selectorsOpen && typeof document !== "undefined"
      ? createPortal(
          <div className="fixed inset-0 z-[460] flex items-end justify-center sm:items-center sm:p-4">
            <button
              type="button"
              className="absolute inset-0 bg-black/45"
              aria-label="Close menu"
              onClick={() => setSelectorsOpen(false)}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="member-selectors-menu-title"
              className="relative z-[1] isolate mb-[max(0px,env(safe-area-inset-bottom))] flex max-h-[min(88dvh,calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-0.5rem))] w-full max-w-sm flex-col overflow-hidden border border-border bg-card shadow-2xl sm:mb-0 sm:rounded-2xl rounded-t-2xl"
            >
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2.5 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
                <h2 id="member-selectors-menu-title" className="text-base font-semibold leading-tight">
                  View & household
                </h2>
                <button
                  type="button"
                  onClick={() => setSelectorsOpen(false)}
                  className="rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  Close
                </button>
              </div>
              <div className="min-h-0 shrink overflow-hidden px-2.5 py-2">{selectorsMenuBody}</div>
            </div>
          </div>,
          document.body,
        )
      : null

  return (
    <>
    <main
      className={cn(
        "flex w-full flex-1 flex-col",
        isNativeShell ? "min-h-0 gap-2 p-2" : "gap-4 p-4 md:p-6",
      )}
    >
      {!isNativeShell ? (
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Member dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Toggle household members to choose visible lanes and which visible lanes are editable.
            </p>
          </div>
          {isKioskMode ? (
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <button
                type="button"
                onClick={() => void exitKioskMode()}
                disabled={isKioskPending}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-800 bg-red-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-700 disabled:opacity-50"
              >
                <LogOut className="size-4 shrink-0" aria-hidden />
                Exit kiosk mode
              </button>
              <button
                type="button"
                onClick={() => void forgotKioskPin()}
                disabled={isKioskPending}
                className="text-xs text-red-700 underline hover:text-red-800 disabled:opacity-50"
              >
                Forgot PIN
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSelectorsOpen((open) => !open)}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-background hover:bg-muted"
              aria-label="Toggle selectors menu"
              aria-expanded={selectorsOpen}
            >
              <Menu className="size-5" />
            </button>
          )}
        </header>
      ) : null}

      <section className={cn("min-h-0 rounded border", isNativeShell ? "flex flex-1 flex-col p-2" : "p-4")}>
        <h2 className={cn("mb-3 font-medium", isNativeShell && "sr-only")}>
          Task lanes ({selectedMembers.length} selected)
        </h2>
        <div className={cn("flex gap-3 overflow-x-auto pb-1", isNativeShell && "min-h-0 flex-1")}>
          {selectedMembers.map((member) => {
            const laneTasks = tasksByMember.get(member.id) ?? []
            const laneIsEditable = editableMemberSet.has(member.id)
            const laneCount = Math.max(selectedMembers.length, 1)
            const laneBasis = `calc((100% - ${(laneCount - 1) * 0.75}rem) / ${laneCount})`
            return (
              <div
                key={member.id}
                className="rounded-lg border bg-card p-3"
                style={{ flex: `1 1 ${laneBasis}`, minWidth: "18rem" }}
              >
                <p className="mb-2 text-sm font-semibold">
                  {member.name}
                  {member.id === leaderId ? " (manager + unassigned)" : ""}
                  {!laneIsEditable ? " (read only)" : ""}
                </p>
                <ul className="space-y-2 text-sm">
                  {laneTasks.map((task) => (
                    <TaskRow
                      key={`${member.id}:${task.occurrence_id}:${task.id}`}
                      task={task}
                      currentMemberId={member.id}
                      isEditable={laneIsEditable}
                    />
                  ))}
                  {laneTasks.length === 0 ? <li className="text-muted-foreground">No active tasks.</li> : null}
                </ul>
              </div>
            )
          })}
        </div>
      </section>

      {activeTask ? (
        <div className="fixed inset-0 z-[480] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded-xl bg-background p-5 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-4">
              <h3 className="text-lg font-semibold">{activeTask.title}</h3>
              <button
                type="button"
                onClick={() => setActiveTask(null)}
                className="rounded border px-2 py-1 text-xs hover:bg-muted"
              >
                Close
              </button>
            </div>
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                Board: {activeTask.occurrence_title ?? (activeTask.occurrence_kind === "manual" ? "Manual board" : "Routine board")}
              </p>
              <p className="text-muted-foreground">
                Assignees:{" "}
                {activeTask.assignee_ids.length > 0
                  ? activeTask.assignee_ids.map((id) => memberNameById.get(id) ?? id).join(", ")
                  : "Unassigned"}
              </p>
              <div>
                <p className="mb-1 font-medium">Task details</p>
                <p className="whitespace-pre-wrap rounded border bg-card p-3">
                  {activeTask.description?.trim() ? activeTask.description : "No task notes yet."}
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
    {isNativeShell && fabPos !== null ? (
      isKioskMode ? (
        <>
          <button
            type="button"
            style={{ left: fabPos.left, top: fabPos.top, width: FAB_SIZE, height: FAB_SIZE }}
            className="fixed z-[430] flex items-center justify-center rounded-full border border-red-900 bg-red-600 text-white shadow-lg ring-1 ring-black/15 hover:bg-red-700 active:scale-95 disabled:opacity-50"
            aria-label="Exit kiosk mode"
            disabled={isKioskPending}
            onClick={() => void exitKioskMode()}
          >
            <LogOut className="size-6" aria-hidden />
          </button>
          <div className="pointer-events-auto fixed bottom-[max(0.5rem,env(safe-area-inset-bottom))] left-0 right-0 z-[425] flex justify-center px-4">
            <button
              type="button"
              onClick={() => void forgotKioskPin()}
              disabled={isKioskPending}
              className="text-xs font-medium text-red-700 underline decoration-red-700/60 underline-offset-2 hover:text-red-900 disabled:opacity-50"
            >
              Forgot PIN
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          style={{ left: fabPos.left, top: fabPos.top, width: FAB_SIZE, height: FAB_SIZE }}
          className="fixed z-[430] flex touch-none items-center justify-center rounded-full border border-border bg-primary text-primary-foreground shadow-lg ring-1 ring-black/10 active:scale-95"
          aria-label={selectorsOpen ? "Close menu" : "Open menu"}
          aria-expanded={selectorsOpen}
          onPointerDown={onFabPointerDown}
          onPointerMove={onFabPointerMove}
          onPointerUp={onFabPointerUp}
          onPointerCancel={onFabPointerCancel}
        >
          <Menu className="size-6" aria-hidden />
        </button>
      )
    ) : null}
    {selectorsMenuPortal}
    </>
  )
}
