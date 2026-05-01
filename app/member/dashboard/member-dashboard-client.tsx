"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Menu } from "lucide-react"
import { useClerk } from "@clerk/nextjs"
import type { EffectiveRole } from "@/lib/household-authz"

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
  const refreshOccurrenceStatusesRef = useRef<(occurrenceId: string) => Promise<void>>(async () => {})

  useEffect(() => {
    setHasHydrated(true)
  }, [])

  useEffect(() => {
    setLocalTasks(tasks)
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
      if (json?.occurrenceTaskStatuses?.length) {
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
      }
      void refreshOccurrenceStatuses(task.occurrence_id)
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

  return (
    <main className="flex w-full flex-1 flex-col gap-4 p-4 md:p-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Member dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Toggle household members to choose visible lanes and which visible lanes are editable.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSelectorsOpen((open) => !open)}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-background hover:bg-muted"
          aria-label="Toggle selectors menu"
          aria-expanded={selectorsOpen}
        >
          <Menu className="size-5" />
        </button>
      </header>

      {selectorsOpen ? (
        <div className="space-y-4 rounded border bg-card p-4">
          {isKioskMode ? (
            <section>
              <h2 className="mb-2 font-medium">Kiosk mode</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void exitKioskMode()}
                  className="rounded border px-3 py-1 text-sm hover:bg-muted"
                  disabled={isKioskPending}
                >
                  Exit kiosk mode
                </button>
                <button
                  type="button"
                  onClick={() => void forgotKioskPin()}
                  className="rounded border px-3 py-1 text-sm text-red-700 hover:bg-red-50"
                  disabled={isKioskPending}
                >
                  Forgot PIN
                </button>
              </div>
            </section>
          ) : null}

          {!isKioskMode ? (
            <>
              {canActivateKiosk ? (
                <section>
                  <h2 className="mb-2 font-medium">Kiosk mode</h2>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void activateKioskMode()}
                      className="rounded bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800"
                      disabled={isKioskPending}
                    >
                      Turn on kiosk mode
                    </button>
                  </div>
                </section>
              ) : null}
              {canActivateKiosk ? (
                <section>
                  <h2 className="mb-2 font-medium">Member roles</h2>
                  <div className="space-y-2">
                    {members.map((member) => {
                      const normalizedRole = member.role === "leader" ? "manager" : member.role
                      const canChangeRole = member.id !== leaderId
                      const nextRole = normalizedRole === "supervisor" ? "member" : "supervisor"
                      return (
                        <div key={`role:${member.id}`} className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
                          <div>
                            <p className="font-medium">{member.name}</p>
                            <p className="text-xs text-muted-foreground">Role: {normalizedRole}</p>
                          </div>
                          {canChangeRole ? (
                            <button
                              type="button"
                              onClick={() => void updateMemberRole(member.id, nextRole)}
                              className="rounded border px-2 py-1 text-xs hover:bg-muted"
                              disabled={roleUpdatingMemberId === member.id}
                            >
                              {roleUpdatingMemberId === member.id
                                ? "Saving..."
                                : `Set ${nextRole === "supervisor" ? "Supervisor" : "Member"}`}
                            </button>
                          ) : (
                            <span className="rounded bg-muted px-2 py-1 text-xs">Manager</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              ) : null}

              <section>
                <h2 className="mb-2 font-medium">Household selector</h2>
                <div className="flex flex-wrap gap-2">
                  {memberships.map((membership) => (
                    <Link
                      key={membership.household.id}
                      href={buildDashboardHref(membership.household.id, selectedMemberIds, editableMemberIds)}
                      className={`rounded border px-3 py-1 text-sm ${
                        membership.household.id === selectedHouseholdId ? "bg-black text-white" : ""
                      }`}
                    >
                      {membership.household.name}
                    </Link>
                  ))}
                </div>
              </section>

              <section>
                <h2 className="mb-2 font-medium">Member selector</h2>
                <div className="flex flex-wrap gap-2">
                  {members.map((member) => (
                    <Link
                      key={member.id}
                      href={buildDashboardHref(
                        selectedHouseholdId,
                        toggleMemberSelection(member.id),
                        toggleMemberSelection(member.id).filter((id) => effectiveEditableMemberIds.includes(id)),
                      )}
                      className={`rounded border px-3 py-1 text-sm ${selectedMemberSet.has(member.id) ? "bg-black text-white" : ""}`}
                    >
                      {member.name}
                    </Link>
                  ))}
                </div>
              </section>
              {canConfigureView ? (
                <section>
                  <h2 className="mb-2 font-medium">Editable members</h2>
                  <div className="flex flex-wrap gap-2">
                    {selectedMembers.map((member) => (
                      <Link
                        key={`editable:${member.id}`}
                        href={buildDashboardHref(
                          selectedHouseholdId,
                          selectedMemberIds,
                          toggleEditableSelection(member.id),
                        )}
                        className={`rounded border px-3 py-1 text-sm ${editableMemberSet.has(member.id) ? "bg-green-700 text-white" : ""}`}
                      >
                        {member.name}
                      </Link>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <section className="min-h-0 rounded border p-4">
        <h2 className="mb-3 font-medium">Task lanes ({selectedMembers.length} selected)</h2>
        <div className="flex gap-3 overflow-x-auto pb-1">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
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
  )
}
