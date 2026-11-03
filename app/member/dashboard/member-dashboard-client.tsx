"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useRouter } from "next/navigation"
import { Check, CircleCheck, Gift, LoaderCircle, LockKeyhole, LogOut, Menu, Search, Settings, Sparkles, Users, X } from "lucide-react"
import { UserButton, useClerk } from "@clerk/nextjs"
import { saveMemberDashboardLanePreferences } from "@/lib/actions/member-dashboard"
import { MemberLanesDraftPicker } from "@/components/member-lanes-draft-picker"
import { NotificationBell } from "@/components/notification-bell"
import { isCapacitorNativeShellSync } from "@/lib/native-shell-detect"
import { cn } from "@/lib/utils"
import type { EffectiveRole } from "@/lib/household-authz"

const MEMBER_TOKEN_COLORS: Record<string, string> = {
  rose: "bg-rose-100 text-rose-800", amber: "bg-amber-100 text-amber-800",
  lime: "bg-lime-100 text-lime-800", emerald: "bg-emerald-100 text-emerald-800",
  teal: "bg-teal-100 text-teal-800", cyan: "bg-cyan-100 text-cyan-800",
  sky: "bg-sky-100 text-sky-800", blue: "bg-blue-100 text-blue-800",
  indigo: "bg-indigo-100 text-indigo-800", violet: "bg-violet-100 text-violet-800",
  fuchsia: "bg-fuchsia-100 text-fuchsia-800", slate: "bg-slate-100 text-slate-800",
}

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

function memberIdsOrderEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

function editableIdsOrderedLikeBoard(memberIds: string[], editableIds: string[]) {
  const set = new Set(editableIds)
  return memberIds.filter((id) => set.has(id))
}

type MenuDraft = {
  householdId: string
  memberIds: string[]
  editableIds: string[]
}

type SelectorsModalState = { open: false } | { open: true; draft: MenuDraft }

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
          Waiting for {blockingMemberName} to complete <strong>{task.blocking_task_title}</strong> to
          unlock this task.
        </>
      )
    }
    return (
      <>
        Complete <strong>{task.blocking_task_title}</strong> to unlock
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
  return "Waiting for its unlock conditions"
}

function MemberTaskRow({ task, currentMemberId, isEditable, pending, memberNameById, hasHydrated, onOpen, onToggle }: {
  task: Task; currentMemberId: string; isEditable: boolean; pending: string | null;
  memberNameById: Map<string, string>; hasHydrated: boolean; onOpen: (task: Task) => void;
  onToggle: (task: Task, memberId: string) => Promise<void>;
}) {
  const locked = task.status === "locked"
  const done = task.status === "completed"
  return <li className="member-task" data-status={task.status} data-reward={task.is_reward}>
    <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 p-3.5 text-left">
      <span className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {task.is_reward ? <Gift className="size-3" /> : locked ? <LockKeyhole className="size-3" /> : done ? <CircleCheck className="size-3" /> : <span className="size-1.5 rounded-full bg-primary" />}
        {task.is_reward ? "Reward" : done ? "Completed" : locked ? "Up next" : "Ready to do"}
      </span>
      <span className={cn("block text-sm font-medium leading-5", done && "text-muted-foreground line-through")}>{task.title}</span>
      <span className="mt-1.5 block text-[11px] leading-4 text-muted-foreground">{locked ? lockMessage(task, { currentMemberId, memberNameById, hasHydrated }) : !isEditable ? "View only" : task.occurrence_title ?? "Household task"}</span>
    </button>
    <button type="button" disabled={locked || Boolean(pending) || !isEditable} onClick={() => void onToggle(task, currentMemberId)} aria-label={locked ? task.title + ": locked" : !isEditable ? task.title + ": view only" : done ? "Undo completion of " + task.title : "Complete " + task.title} className={cn("m-2 ml-0 flex w-12 shrink-0 flex-col items-center justify-center gap-1 rounded-lg text-[10px] font-semibold transition-colors disabled:cursor-not-allowed", locked || !isEditable ? "text-muted-foreground" : done ? "text-primary hover:bg-primary/10" : "bg-primary/8 text-primary hover:bg-primary hover:text-white")}>
      {pending === task.id ? <LoaderCircle className="size-4 animate-spin" /> : locked || !isEditable ? <LockKeyhole className="size-4" /> : <Check className="size-4" />}
      {pending === task.id ? "Saving" : locked ? "Locked" : !isEditable ? "View" : done ? "Undo" : "Done"}
    </button>
  </li>
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
  const [taskFilter, setTaskFilter] = useState<"all" | "unlocked" | "completed">("all")
  const [taskSearch, setTaskSearch] = useState("")
  const [taskError, setTaskError] = useState<string | null>(null)
  const taskDialogRef = useRef<HTMLDialogElement>(null)
  const [activeTask, setActiveTask] = useState<Task | null>(null)
  const [isToggling, setIsToggling] = useState<string | null>(null)
  const [selectorsModal, setSelectorsModal] = useState<SelectorsModalState>({ open: false })
  const selectorsModalRef = useRef<SelectorsModalState>({ open: false })
  const selectorsOpen = selectorsModal.open === true
  const [isKioskMode, setIsKioskMode] = useState(kioskActive)
  const [isKioskPending, setIsKioskPending] = useState(false)
  const [roleUpdatingMemberId, setRoleUpdatingMemberId] = useState<string | null>(null)
  const [hasHydrated, setHasHydrated] = useState(false)
  const [isNativeShell, setIsNativeShell] = useState(isCapacitorNativeShellSync)
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
    queueMicrotask(() => setHasHydrated(true))
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
    queueMicrotask(() => setLocalTasks(tasks))
  }, [tasks])

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
  const editableMemberSet = useMemo(() => {
    if (viewerRole !== "member") return new Set(editableMemberIds)
    return new Set(selectedMemberIds.filter((id) => id === viewerUserId))
  }, [editableMemberIds, selectedMemberIds, viewerRole, viewerUserId])
  const effectiveEditableMemberIds = useMemo(() => [...editableMemberSet], [editableMemberSet])
  const canConfigureView = viewerRole === "manager" || viewerRole === "supervisor"
  const canActivateKiosk = viewerRole === "manager"
  const selectedMembers = useMemo(() => {
    const byId = new Map(members.map((member) => [member.id, member]))
    return selectedMemberIds.map((id) => byId.get(id)).filter(Boolean) as Member[]
  }, [members, selectedMemberIds])
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

  const openSelectors = useCallback(() => {
    setSelectorsModal({
      open: true,
      draft: {
        householdId: selectedHouseholdId,
        memberIds: [...selectedMemberIds],
        editableIds: [...editableMemberIds],
      },
    })
  }, [selectedHouseholdId, selectedMemberIds, editableMemberIds])

  const closeSelectors = useCallback(async () => {
    const snap = selectorsModalRef.current
    if (snap.open !== true) return
    const { draft } = snap
    const same =
      draft.householdId === selectedHouseholdId &&
      memberIdsOrderEqual(draft.memberIds, selectedMemberIds) &&
      memberIdsOrderEqual(
        editableIdsOrderedLikeBoard(draft.memberIds, draft.editableIds),
        editableIdsOrderedLikeBoard(selectedMemberIds, editableMemberIds),
      )
    if (same) {
      setSelectorsModal({ open: false })
      return
    }
    const editableForSave = editableIdsOrderedLikeBoard(draft.memberIds, draft.editableIds)
    if (canConfigureView) {
      const result = await saveMemberDashboardLanePreferences(
        draft.householdId,
        draft.memberIds,
        editableForSave,
      )
      if (!result.ok) {
        window.alert(result.error)
        return
      }
    }
    setSelectorsModal({ open: false })
    const next = `/member/dashboard?household=${encodeURIComponent(draft.householdId)}`
    router.replace(next)
    router.refresh()
  }, [
    router,
    selectedHouseholdId,
    selectedMemberIds,
    editableMemberIds,
    canConfigureView,
  ])

  useEffect(() => {
    if (!selectorsOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSelectors()
    }
    window.addEventListener("keydown", onKeyDown)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = prevOverflow
    }
  }, [selectorsOpen, closeSelectors])

  useEffect(() => {
    if (isKioskMode) closeSelectors()
  }, [isKioskMode, closeSelectors])

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

  useLayoutEffect(() => {
    selectorsModalRef.current = selectorsModal
  }, [selectorsModal])

  useLayoutEffect(() => {
    refreshOccurrenceStatusesRef.current = refreshOccurrenceStatuses
  }, [refreshOccurrenceStatuses])

  const toggleTaskCompleted = async (task: Task, actingMemberId: string) => {
    if (task.status === "locked" || isToggling || !editableMemberSet.has(actingMemberId)) return
    setTaskError(null)
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
      setLocalTasks((prev) => prev.map((row) => row.id === task.id ? { ...row, status: task.status } : row))
      setTaskError("We couldn’t save that change. Your task has been restored. Please try again.")
      console.error(error)
    } finally {
      setIsToggling(null)
    }
  }

  const activateKioskMode = async () => {
    if (isKioskPending) return
    const pin = window.prompt("Set a new kiosk PIN")
    if (!pin) return
    const modal = selectorsModalRef.current
    const draft = modal.open === true ? modal.draft : null
    const kioskHouseholdId = draft?.householdId ?? selectedHouseholdId
    const kioskVisibleIds = draft?.memberIds ?? selectedMemberIds
    const kioskEditableIds = draft?.editableIds ?? editableMemberIds
    setIsKioskPending(true)
    try {
      const response = await fetch("/api/leader/flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "activateKioskMode",
          householdId: kioskHouseholdId,
          pin,
          visibleMemberIds: kioskVisibleIds,
          editableMemberIds: kioskEditableIds,
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
          householdId:
            (selectorsModalRef.current.open === true
              ? selectorsModalRef.current.draft.householdId
              : selectedHouseholdId),
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
    if (selectorsOpen) closeSelectors()
    else openSelectors()
  }, [selectorsOpen, closeSelectors, openSelectors])

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

  const visibleTasks = [...new Map(selectedMembers.flatMap(member => tasksByMember.get(member.id) ?? []).map(task => [task.id, task])).values()]
  const readyCount = visibleTasks.filter(task => task.status === "unlocked").length
  const completeCount = visibleTasks.filter(task => task.status === "completed").length
  const householdName = memberships.find(membership => membership.household.id === selectedHouseholdId)?.household.name ?? "Your household"

  useEffect(() => {
    if (activeTask && taskDialogRef.current && !taskDialogRef.current.open) taskDialogRef.current.showModal()
  }, [activeTask])

  const sectionLabelClass = "mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"

  const draftForMenu =
    selectorsModal.open === true
      ? selectorsModal.draft
      : {
          householdId: selectedHouseholdId,
          memberIds: selectedMemberIds,
          editableIds: editableMemberIds,
        }

  const singleHouseholdHeaderName = useMemo(() => {
    if (memberships.length !== 1) return null
    const id =
      selectorsModal.open === true ? selectorsModal.draft.householdId : selectedHouseholdId
    return memberships.find((m) => m.household.id === id)?.household.name ?? "Household"
  }, [memberships, selectorsModal, selectedHouseholdId])
  const selectorsMenuBody = (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden">
      {isNativeShell && hasHydrated ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border pb-1.5">
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
            <section className="shrink-0">
              <h3 className={sectionLabelClass}>Kiosk</h3>
              <button
                type="button"
                onClick={() => void activateKioskMode()}
                className="rounded bg-black px-2 py-1 text-[11px] font-medium text-white hover:bg-zinc-800"
                disabled={isKioskPending}
              >
                Turn on
              </button>
            </section>
          ) : null}

          <section className="flex min-h-0 flex-1 flex-col">
            <h3 className={sectionLabelClass}>Board lanes</h3>
            <MemberLanesDraftPicker
              members={members.map((m) => ({ id: m.id, name: m.name }))}
              boardMemberIds={draftForMenu.memberIds}
              editableMemberIds={draftForMenu.editableIds}
              canConfigureEdit={canConfigureView}
              editableGrantableMemberIds={canConfigureView ? members.map((m) => m.id) : []}
              onChange={({ memberIds, editableMemberIds }) =>
                setSelectorsModal((prev) =>
                  prev.open === true
                    ? {
                        open: true,
                        draft: { ...prev.draft, memberIds, editableIds: editableMemberIds },
                      }
                    : prev,
                )
              }
            />
          </section>

          {canActivateKiosk ? (
            <section className="shrink-0">
              <h3 className={sectionLabelClass}>Member roles</h3>
              <div className="space-y-0.5">
                {members.map((member) => {
                  const normalizedRole = member.role === "leader" ? "manager" : member.role
                  const canChangeRole = member.id !== leaderId
                  const nextRole = normalizedRole === "supervisor" ? "member" : "supervisor"
                  return (
                    <div
                      key={`role:${member.id}`}
                      className="flex items-center justify-between gap-1 rounded border border-border/80 px-1.5 py-0.5 text-[10px] leading-tight"
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
              onClick={() => closeSelectors()}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="member-selectors-menu-title"
              className="relative z-[1] isolate mb-[max(0px,env(safe-area-inset-bottom))] flex max-h-[min(92dvh,calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-0.5rem))] w-full max-w-lg flex-col overflow-hidden border border-border bg-card shadow-2xl sm:mb-0 sm:rounded-2xl rounded-t-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-2.5 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
                <h2
                  id="member-selectors-menu-title"
                  className="min-w-0 shrink text-sm font-semibold leading-tight sm:text-base"
                >
                  View & household
                </h2>
                <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
                  {!isKioskMode ? (
                    memberships.length <= 1 ? (
                      <span
                        className="min-w-0 max-w-[min(14rem,48vw)] shrink-0 truncate px-1 py-1.5 text-xs font-medium text-foreground"
                        title={singleHouseholdHeaderName ?? undefined}
                      >
                        {singleHouseholdHeaderName}
                      </span>
                    ) : (
                      <select
                        aria-label="Household"
                        className="min-w-[10rem] max-w-[min(14rem,48vw)] shrink-0 truncate rounded-md border border-input bg-background px-2 py-1.5 text-xs font-medium text-foreground shadow-sm"
                        value={
                          selectorsModal.open === true
                            ? selectorsModal.draft.householdId
                            : selectedHouseholdId
                        }
                        onChange={(e) =>
                          setSelectorsModal((prev) =>
                            prev.open === true
                              ? { open: true, draft: { ...prev.draft, householdId: e.target.value } }
                              : prev,
                          )
                        }
                      >
                        {memberships.map((membership) => (
                          <option key={membership.household.id} value={membership.household.id}>
                            {membership.household.name}
                          </option>
                        ))}
                      </select>
                    )
                  ) : null}
                  <button
                    type="button"
                    onClick={() => closeSelectors()}
                    className="shrink-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2 pt-1">{selectorsMenuBody}</div>
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
        isNativeShell ? "native-member-board min-h-0 gap-2 p-2" : "gap-6 p-4 md:px-8 md:py-7",
      )}
    >
      {!isNativeShell ? (
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">{householdName}</p>
            <h1 className="text-3xl font-semibold tracking-tight">A little progress, together.</h1>
            <p className="text-sm text-muted-foreground">
              See what’s ready, take the next step, and celebrate what’s done.
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
              onClick={() => (selectorsOpen ? closeSelectors() : openSelectors())}
              className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border bg-card px-3 text-xs font-medium hover:bg-muted"
              aria-label="Board settings"
              aria-expanded={selectorsOpen}
            >
              <Settings className="size-4" /><span className="hidden sm:inline">Board settings</span>
            </button>
          )}
        </header>
      ) : null}

      {!isNativeShell && <div className="grid grid-cols-3 gap-3">
        {[{ label: "Ready to do", count: readyCount, icon: Sparkles, color: "bg-[#e7f0e4] text-primary" }, { label: "Completed", count: completeCount, icon: CircleCheck, color: "bg-[#f5eddd] text-[#8a642b]" }, { label: "On the board", count: selectedMembers.length, icon: Users, color: "bg-[#eee8f5] text-[#79608c]" }].map(({ label, count, icon: Icon, color }) => <div key={label} className="flex items-center gap-3 rounded-xl border bg-card p-3 sm:p-4"><span className={cn("hidden size-10 items-center justify-center rounded-xl sm:flex", color)}><Icon className="size-4" /></span><div><p className="text-2xl font-semibold tracking-tight">{count}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p></div></div>)}
      </div>}
      {taskError && <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{taskError}<button type="button" onClick={() => setTaskError(null)} aria-label="Dismiss error"><X className="size-4" /></button></div>}
      <section aria-label="Household tasks" className={cn("min-h-0", isNativeShell && "flex flex-1 flex-col")}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 rounded-xl border bg-card p-1" aria-label="Filter tasks">
            {([['all', 'All tasks'], ['unlocked', 'Ready'], ['completed', 'Completed']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={taskFilter === value} onClick={() => setTaskFilter(value)} className={cn("rounded-lg px-3 py-2 text-xs font-medium", taskFilter === value ? "bg-primary text-white" : "text-muted-foreground hover:bg-muted")}>{label}</button>)}
          </div>
          <div className="relative w-full sm:w-60"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><input type="search" aria-label="Find a task on the board" placeholder="Find a task…" value={taskSearch} onChange={event => setTaskSearch(event.target.value)} className="h-10 w-full rounded-xl border bg-card pl-9 pr-3 text-sm" /></div>
        </div>
        <div className={cn("member-lanes", isNativeShell && "min-h-0 flex-1")}>
          {selectedMembers.map((member) => {
            const allLaneTasks = tasksByMember.get(member.id) ?? []
            const laneTasks = allLaneTasks.filter(task => (taskFilter === "all" || task.status === taskFilter) && (task.title + " " + (task.occurrence_title ?? "")).toLowerCase().includes(taskSearch.trim().toLowerCase()))
            const doneCount = allLaneTasks.filter(task => task.status === "completed").length
            const laneIsEditable = editableMemberSet.has(member.id)
            return <div key={member.id} className={cn("member-lane", isNativeShell && "overflow-y-auto")}>
              <div className="member-lane-header">
                <div className="mb-4 flex items-center gap-3"><span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold", MEMBER_TOKEN_COLORS[member.token_color ?? ""] ?? "bg-primary/10 text-primary")}>{member.name.split(" ").map(part => part[0]).slice(0, 2).join("")}</span><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{member.name}</h2><p className="mt-1 text-[10px] text-muted-foreground">{member.id === leaderId ? "Includes unassigned tasks" : laneIsEditable ? "One step at a time" : "View only"}</p></div><span className="rounded-full border bg-white px-2 py-1 text-[10px] font-medium text-muted-foreground">{doneCount}/{allLaneTasks.length}</span></div>
                <div role="progressbar" aria-label={member.name + "’s task progress"} aria-valuenow={doneCount} aria-valuemin={0} aria-valuemax={allLaneTasks.length || 1} className="h-1 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: allLaneTasks.length ? doneCount / allLaneTasks.length * 100 + "%" : "0%" }} /></div>
              </div>
              <ul className="space-y-3 p-3">
                {laneTasks.map(task => <MemberTaskRow key={member.id + ":" + task.occurrence_id + ":" + task.id} task={task} currentMemberId={member.id} isEditable={laneIsEditable} pending={isToggling} memberNameById={memberNameById} hasHydrated={hasHydrated} onOpen={setActiveTask} onToggle={toggleTaskCompleted} />)}
                {laneTasks.length === 0 && <li className="px-4 py-10 text-center"><CircleCheck className="mx-auto mb-3 size-7 text-primary/50" /><p className="text-sm font-medium">{allLaneTasks.length ? "No matching tasks" : "A little breathing room"}</p><p className="mt-2 text-xs leading-5 text-muted-foreground">{allLaneTasks.length ? "Try another filter or search." : "No tasks here right now."}</p></li>}
              </ul>
            </div>
          })}
          {selectedMembers.length === 0 && <p className="rounded-xl border bg-card p-8 text-sm text-muted-foreground">Choose family members in Board settings to see their tasks.</p>}
        </div>
      </section>

      {activeTask ? (
        <dialog ref={taskDialogRef} onCancel={() => setActiveTask(null)} aria-labelledby="task-detail-title" className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/40">
          <div className="w-full max-w-lg rounded-xl bg-background p-5 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-4">
              <h3 id="task-detail-title" className="text-lg font-semibold">{activeTask.title}</h3>
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
        </dialog>
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
