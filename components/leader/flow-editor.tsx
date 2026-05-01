"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type MouseEvent as ReactMouseEvent,
} from "react"
import { useRouter } from "next/navigation"
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnEdgesChange,
  type OnNodesChange,
  type ReactFlowInstance,
} from "@xyflow/react"
import { ChevronDown, ChevronRight, Lock, LockOpen, Minus, Plus, Trash2 } from "lucide-react"
import "@xyflow/react/dist/style.css"
import { Button } from "@/components/ui/button"
import type { Household, Routine, RoutineOccurrence, Task } from "@/lib/types"
import {
  type MonthlyNth,
  type RecurrenceRule,
  type Weekday,
  nextRecurrenceDate,
  parseRoutineRecurrenceRules,
  recurrenceRuleSummary,
  serializeRoutineRecurrenceRules,
} from "@/lib/recurrence"
import { cn } from "@/lib/utils"
import { isRenderableUserProfilePhotoUrl } from "@/lib/clerk-profile-image-url"

type Member = {
  id: string
  name: string
  avatar_url?: string | null
  token_color?: string | null
  role?: "manager" | "supervisor" | "member" | "leader"
  is_clerk_linked?: boolean
  tokenColorClass?: string
}
type Dependency = { source_task_id: string; target_task_id: string }
type TaskListItem = { id: string; routine_id: string | null; title: string; is_reward?: boolean }
type TaskAssignee = { task_id: string; user_id: string }
type HouseholdInvite = {
  id: string
  code: string
  expires_at: string
  max_uses: number
  uses_count: number
  is_active: boolean
  created_at: string
}
type OccurrenceTaskStatus = { task_id: string; status: string }

const TOKEN_COLOR_OPTIONS = [
  { id: "rose", className: "bg-rose-200 text-rose-900" },
  { id: "amber", className: "bg-amber-200 text-amber-900" },
  { id: "lime", className: "bg-lime-200 text-lime-900" },
  { id: "emerald", className: "bg-emerald-200 text-emerald-900" },
  { id: "teal", className: "bg-teal-200 text-teal-900" },
  { id: "cyan", className: "bg-cyan-200 text-cyan-900" },
  { id: "sky", className: "bg-sky-200 text-sky-900" },
  { id: "blue", className: "bg-blue-200 text-blue-900" },
  { id: "indigo", className: "bg-indigo-200 text-indigo-900" },
  { id: "violet", className: "bg-violet-200 text-violet-900" },
  { id: "fuchsia", className: "bg-fuchsia-200 text-fuchsia-900" },
  { id: "pink", className: "bg-pink-200 text-pink-900" },
  { id: "orange", className: "bg-orange-200 text-orange-900" },
  { id: "red", className: "bg-red-200 text-red-900" },
  { id: "slate", className: "bg-slate-200 text-slate-900" },
  { id: "zinc", className: "bg-zinc-200 text-zinc-900" },
] as const

const GUIDE_SPAN = 100_000

type GuidePlaceMode = "horizontal" | "vertical"

type DayDividerData = {
  orientation: GuidePlaceMode
  label: string
  locked?: boolean
  labelOffsetX?: number
  labelOffsetY?: number
  preview?: boolean
  isEditing?: boolean
  editValue?: string
  onEditValueChange?: (value: string) => void
  onEditCommit?: () => void
  onEditCancel?: () => void
}

type GuideSnapshot = {
  id: string
  position: { x: number; y: number }
  data: DayDividerData
}

function guideStorageKey(householdId: string, routineId: string | null, occurrenceId: string | null) {
  if (occurrenceId) {
    // Occurrence boards are uniquely identified by occurrence id; do not include routine id,
    // which can vary by navigation path and break guide persistence.
    return `houseflow:flow-guides:${householdId}:occurrence:${occurrenceId}`
  }
  return `houseflow:flow-guides:${householdId}:template:${routineId ?? "none"}`
}

function loadGuideNodes(key: string): Node<DayDividerData>[] {
  if (typeof window === "undefined") return []
  const parse = (raw: string | null): Node<DayDividerData>[] => {
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<{
      id: string
      position: { x: number; y: number }
      data: DayDividerData
    }>
    return parsed.map((g) => ({
      id: g.id,
      type: "dayDivider",
      position: g.position,
      data: {
        orientation: g.data.orientation,
        label: g.data.label ?? "",
        locked: Boolean(g.data.locked),
        labelOffsetX: Number.isFinite(g.data.labelOffsetX) ? g.data.labelOffsetX : 0,
        labelOffsetY: Number.isFinite(g.data.labelOffsetY) ? g.data.labelOffsetY : 0,
      },
      draggable: !g.data.locked,
      selectable: true,
      zIndex: 0,
    }))
  }

  try {
    const primary = parse(localStorage.getItem(key))
    if (primary.length > 0) return primary

    // Backward compatibility: recover occurrence guide lines saved with older key shapes.
    const occurrenceMatch = key.match(/^houseflow:flow-guides:([^:]+):occurrence:(.+)$/)
    if (occurrenceMatch) {
      const householdId = occurrenceMatch[1]
      const occurrenceId = occurrenceMatch[2]
      for (let idx = 0; idx < localStorage.length; idx += 1) {
        const candidateKey = localStorage.key(idx)
        if (!candidateKey || candidateKey === key) continue
        if (!candidateKey.startsWith(`houseflow:flow-guides:${householdId}:`)) continue
        if (!candidateKey.includes(`occurrence:${occurrenceId}`)) continue
        const recovered = parse(localStorage.getItem(candidateKey))
        if (recovered.length > 0) return recovered
      }
    }

    return []
  } catch {
    return []
  }
}

function saveGuideNodes(key: string, guides: Node<DayDividerData>[]) {
  if (typeof window === "undefined") return
  const minimal = guides.map((g) => ({
    id: g.id,
    position: g.position,
    data: {
      orientation: g.data.orientation,
      label: typeof g.data.label === "string" ? g.data.label : "",
      locked: Boolean(g.data.locked),
      labelOffsetX: Number.isFinite(g.data.labelOffsetX) ? g.data.labelOffsetX : 0,
      labelOffsetY: Number.isFinite(g.data.labelOffsetY) ? g.data.labelOffsetY : 0,
    },
  }))
  localStorage.setItem(key, JSON.stringify(minimal))
}

function readGuideSnapshots(key: string): GuideSnapshot[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    return JSON.parse(raw) as GuideSnapshot[]
  } catch {
    return []
  }
}

function cloneTemplateGuidesToOccurrence(
  householdId: string,
  routineId: string,
  occurrenceId: string,
) {
  if (typeof window === "undefined") return
  const templateKey = guideStorageKey(householdId, routineId, null)
  const occurrenceKey = guideStorageKey(householdId, routineId, occurrenceId)
  const existingOccurrence = readGuideSnapshots(occurrenceKey)
  if (existingOccurrence.length > 0) return
  const templateGuides = readGuideSnapshots(templateKey)
  if (templateGuides.length === 0) return

  const cloned = templateGuides.map((guide) => ({
    ...guide,
    id: `guide-${crypto.randomUUID()}`,
  }))
  localStorage.setItem(occurrenceKey, JSON.stringify(cloned))
}

function mergeTaskNodesWithGuides(key: string, taskNodes: Node[]): Node[] {
  return [...loadGuideNodes(key), ...taskNodes]
}

type LastManagementSelection = {
  routineId: string | null
  occurrenceId: string | null
}

function lastManagementSelectionKey(householdId: string) {
  return `houseflow:last-management-selection:${householdId}`
}

function loadLastManagementSelection(key: string): LastManagementSelection | null {
  if (typeof window === "undefined") return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      routineId?: unknown
      occurrenceId?: unknown
    }
    return {
      routineId: typeof parsed.routineId === "string" && parsed.routineId ? parsed.routineId : null,
      occurrenceId:
        typeof parsed.occurrenceId === "string" && parsed.occurrenceId ? parsed.occurrenceId : null,
    }
  } catch {
    return null
  }
}

function saveLastManagementSelection(key: string, selection: LastManagementSelection) {
  if (typeof window === "undefined") return
  localStorage.setItem(key, JSON.stringify(selection))
}

function formatDateStable(isoLike: string) {
  const d = new Date(isoLike)
  if (Number.isNaN(d.getTime())) return isoLike
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function normalizeDateInput(raw: string): string {
  const value = raw.trim()
  if (!value) return ""
  // Native date input value format.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  // Fallback for locale-typed dates like dd/mm/yyyy.
  const slash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slash) {
    const day = slash[1].padStart(2, "0")
    const month = slash[2].padStart(2, "0")
    const year = slash[3]
    return `${year}-${month}-${day}`
  }
  return ""
}

function toDateInputValue(value: unknown): string {
  if (!value) return ""
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear()
    const m = String(value.getMonth() + 1).padStart(2, "0")
    const d = String(value.getDate()).padStart(2, "0")
    return `${y}-${m}-${d}`
  }
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const parsed = new Date(text)
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear()
    const m = String(parsed.getMonth() + 1).padStart(2, "0")
    const d = String(parsed.getDate()).padStart(2, "0")
    return `${y}-${m}-${d}`
  }
  return ""
}

function toTimeInputValue(value: unknown): string {
  if (!value) return ""
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const hh = String(value.getHours()).padStart(2, "0")
    const mm = String(value.getMinutes()).padStart(2, "0")
    return `${hh}:${mm}`
  }
  const text = String(value)
  const isoTimeMatch = text.match(/T(\d{2}:\d{2})/)
  if (isoTimeMatch?.[1]) return isoTimeMatch[1]
  const hhmmMatch = text.match(/^(\d{2}:\d{2})/)
  if (hhmmMatch?.[1]) return hhmmMatch[1]
  const parsed = new Date(text)
  if (!Number.isNaN(parsed.getTime())) {
    const hh = String(parsed.getHours()).padStart(2, "0")
    const mm = String(parsed.getMinutes()).padStart(2, "0")
    return `${hh}:${mm}`
  }
  return ""
}

function memberColorFor(seed: string) {
  const palette = TOKEN_COLOR_OPTIONS.map((c) => c.className)
  const sum = seed.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return palette[sum % palette.length]
}

function buildMemberTokenColorMap(members: Member[]) {
  const palette = TOKEN_COLOR_OPTIONS.map((c) => c.className)
  const classById = new Map(TOKEN_COLOR_OPTIONS.map((c) => [c.id, c.className]))

  const map = new Map<string, string>()
  const used = new Set<string>()

  members.forEach((member) => {
    if (!member.token_color) return
    const cls = classById.get(member.token_color as (typeof TOKEN_COLOR_OPTIONS)[number]["id"])
    if (!cls) return
    map.set(member.id, cls)
    used.add(cls)
  })

  let nextIdx = 0
  members.forEach((member) => {
    if (map.has(member.id)) return
    while (nextIdx < palette.length && used.has(palette[nextIdx])) nextIdx += 1
    const chosen =
      nextIdx < palette.length ? palette[nextIdx] : palette[map.size % palette.length]
    map.set(member.id, chosen)
    used.add(chosen)
    nextIdx += 1
  })
  return map
}

function memberInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
}

type TaskNodeData = {
  title: string
  status: string
  isReward: boolean
  highlighted: boolean
  assignees: Member[]
  occurrenceView: boolean
  occurrenceStatus: string
  lockTooltip?: string | null
  onToggleOccurrenceComplete?: () => void
}

function TaskNode({ data, selected }: NodeProps<Node<TaskNodeData>>) {
  const [isClientMounted, setIsClientMounted] = useState(false)
  useEffect(() => {
    setIsClientMounted(true)
  }, [])
  const initials = (name: string) =>
    name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("")

  const isComplete = data.occurrenceStatus === "completed"
  const isLocked = data.occurrenceStatus === "locked"
  const canToggleOccurrence =
    data.occurrenceView && data.onToggleOccurrenceComplete && (!isLocked || isComplete)
  const tooltip = isLocked ? data.lockTooltip ?? "Locked" : undefined

  /** Completed task: light grey. Completed reward: same grey-blue as locked rewards on member dashboard. */
  const surfaceClass = cn(
    "relative w-[220px] max-w-[220px] rounded-xl border p-3 shadow-sm",
    isComplete
      ? data.isReward
        ? "border-slate-300 bg-sky-50/60"
        : "border-zinc-300 bg-zinc-100"
      : data.isReward
        ? "border-sky-300 bg-sky-50"
        : "border-zinc-300 bg-white",
    data.occurrenceView ? "pr-9" : "",
    data.highlighted || selected ? "ring-2 ring-blue-500 ring-offset-2" : "",
  )

  return (
    <div title={isClientMounted ? tooltip : undefined} className={surfaceClass}>
      <Handle type="target" position={Position.Top} className="!h-3 !w-3 !bg-zinc-700" />
      {data.occurrenceView ? (
        <input
          type="checkbox"
          checked={isComplete}
          disabled={!canToggleOccurrence}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onChange={() => {
            if (canToggleOccurrence) data.onToggleOccurrenceComplete?.()
          }}
          aria-label={
            isComplete ? "Task completed, click to mark incomplete"
            : isLocked ? "Locked until prerequisites are completed"
            : "Mark task complete"
          }
          title={
            isComplete ? "Completed — click to undo"
            : isLocked ? "Complete prerequisites first"
            : "Mark complete"
          }
          className={`absolute right-2 top-2 z-10 m-0 h-3.5 w-3.5 shrink-0 rounded border accent-zinc-900 transition-[border-color,opacity,background-color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:cursor-not-allowed ${
            isLocked && !isComplete
              ? "cursor-not-allowed border-zinc-300 bg-zinc-200 opacity-50"
              : "cursor-pointer border-zinc-400 bg-white hover:border-zinc-500"
          }`}
        />
      ) : null}
      {data.occurrenceView && isLocked && !isComplete ? (
        <div
          aria-hidden
          className="absolute right-2 top-2 z-[11] h-3.5 w-3.5 cursor-not-allowed rounded"
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        />
      ) : null}
      <div className="mb-1 flex items-center justify-between gap-2">
        <p
          className={cn(
            "text-xs uppercase tracking-wide",
            isComplete ? (data.isReward ? "text-slate-500" : "text-zinc-400") : "text-zinc-500",
          )}
        >
          {data.isReward ? "Reward" : "Task"}
        </p>
        <div className="flex shrink-0 -space-x-1">
          {data.assignees.length <= 4
            ? data.assignees.slice(0, 4).map((assignee) =>
                isRenderableUserProfilePhotoUrl(assignee.avatar_url) && !assignee.token_color ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={assignee.id}
                    src={assignee.avatar_url!}
                    alt={assignee.name}
                    className="h-5 w-5 rounded-full border border-white object-cover"
                    title={assignee.name}
                  />
                ) : (
                  <div
                    key={assignee.id}
                    className={`flex h-5 w-5 items-center justify-center rounded-full border border-white text-[9px] font-semibold ${
                      assignee.tokenColorClass ?? memberColorFor(assignee.id)
                    }`}
                    title={assignee.name}
                  >
                    {initials(assignee.name)}
                  </div>
                ),
              )
            : [
                ...data.assignees.slice(0, 3).map((assignee) =>
                  isRenderableUserProfilePhotoUrl(assignee.avatar_url) && !assignee.token_color ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={assignee.id}
                      src={assignee.avatar_url!}
                      alt={assignee.name}
                      className="h-5 w-5 rounded-full border border-white object-cover"
                      title={assignee.name}
                    />
                  ) : (
                    <div
                      key={assignee.id}
                      className={`flex h-5 w-5 items-center justify-center rounded-full border border-white text-[9px] font-semibold ${
                        assignee.tokenColorClass ?? memberColorFor(assignee.id)
                      }`}
                      title={assignee.name}
                    >
                      {initials(assignee.name)}
                    </div>
                  ),
                ),
                <div
                  key="assignee-overflow"
                  className="flex h-5 w-5 items-center justify-center rounded-full border border-white bg-zinc-200 text-[9px] font-semibold text-zinc-700"
                  title={`${data.assignees.length - 3} more assignees`}
                >
                  +{data.assignees.length - 3}
                </div>,
              ]}
        </div>
      </div>
      <p
        className={cn(
          "whitespace-normal break-words font-medium",
          isComplete ? (data.isReward ? "text-slate-800" : "text-zinc-700") : "text-zinc-900",
        )}
      >
        {data.title}
      </p>
      <Handle type="source" position={Position.Bottom} className="!h-3 !w-3 !bg-zinc-700" />
    </div>
  )
}

function DayDividerNode({ data }: NodeProps<Node<DayDividerData>>) {
  const hit = 20
  const lineHitThickness = 12
  const isH = data.orientation === "horizontal"
  const labelOffsetX = data.labelOffsetX ?? 0
  const labelOffsetY = data.labelOffsetY ?? 0
  return (
    <div
      className={`relative ${data.preview ? "pointer-events-none opacity-55" : ""}`}
      style={{
        width: hit,
        height: hit,
      }}
    >
      {!data.preview ? (
        isH ? (
          <div
            className="absolute"
            style={{
              width: GUIDE_SPAN,
              height: lineHitThickness,
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              cursor: data.locked ? "not-allowed" : "row-resize",
              background: "transparent",
            }}
          />
        ) : (
          <div
            className="absolute"
            style={{
              width: lineHitThickness,
              height: GUIDE_SPAN,
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              cursor: data.locked ? "not-allowed" : "col-resize",
              background: "transparent",
            }}
          />
        )
      ) : null}
      {isH ? (
        <div
          className={`absolute top-1/2 border-t-2 ${
            data.preview ? "border-blue-500" : "border-zinc-500"
          } ${data.preview ? "border-dotted" : "border-dashed"}`}
          style={{
            width: GUIDE_SPAN,
            left: "50%",
            transform: "translate(-50%, -50%)",
            cursor: data.preview ? "default" : data.locked ? "not-allowed" : "row-resize",
          }}
        />
      ) : (
        <div
          className={`absolute left-1/2 border-l-2 ${
            data.preview ? "border-blue-500" : "border-zinc-500"
          } border-dotted`}
          style={{
            height: GUIDE_SPAN,
            top: "50%",
            transform: "translate(-50%, -50%)",
            cursor: data.preview ? "default" : data.locked ? "not-allowed" : "col-resize",
          }}
        />
      )}
      {data.isEditing ? (
        <div
          className="absolute left-1/2 top-1/2 z-[2] -translate-x-1/2 -translate-y-1/2"
          style={{ marginLeft: labelOffsetX, marginTop: labelOffsetY }}
        >
          <input
            value={data.editValue ?? ""}
            onChange={(event) => data.onEditValueChange?.(event.target.value)}
            onBlur={() => data.onEditCommit?.()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                data.onEditCommit?.()
              } else if (event.key === "Escape") {
                event.preventDefault()
                data.onEditCancel?.()
              }
            }}
            autoFocus
            className="w-[180px] rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-center text-xs font-medium text-zinc-800 shadow-sm outline-none focus:border-zinc-500"
          />
        </div>
      ) : data.label ? (
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 z-[1] max-w-[min(280px,50vw)] -translate-x-1/2 -translate-y-1/2 text-center text-xs font-medium text-zinc-800"
          style={{ marginLeft: labelOffsetX, marginTop: labelOffsetY }}
        >
          <span className="rounded bg-white px-1.5 py-0.5 shadow-sm">{data.label}</span>
        </div>
      ) : null}
    </div>
  )
}

const nodeTypes = { taskNode: TaskNode, dayDivider: DayDividerNode }

type Props = {
  households: Household[]
  selectedHouseholdId: string
  selectedRoutineId: string | null
  routines: Routine[]
  tasks: Task[]
  dependencies: Dependency[]
  members: Member[]
  allTasks: TaskListItem[]
  invites: HouseholdInvite[]
  occurrences: RoutineOccurrence[]
  selectedOccurrenceId: string | null
  occurrenceTaskStatuses: OccurrenceTaskStatus[]
  taskAssignees: TaskAssignee[]
  /** Assignees for template tasks (all routines); used in sidebar when an occurrence is selected. */
  templateTaskAssignees: TaskAssignee[]
}

type EdgeMenuState = {
  edgeId: string
  sourceTaskId: string
  targetTaskId: string
  x: number
  y: number
}

type OccurrenceMenuState = {
  occurrenceId: string
  routineId?: string
  x: number
  y: number
}

type TaskMenuState = {
  taskId: string
  taskIds: string[]
  routineId?: string
  occurrenceId?: string | null
  x: number
  y: number
}

type RoutinePlusMenuState = {
  routineId: string
  x: number
  y: number
}

type OccurrenceTaskListItem = {
  id: string
  title: string
  status: "locked" | "unlocked" | "completed"
  assignee_ids?: string[]
  is_reward?: boolean
}

function sidebarLeafTaskClass(isReward: boolean, isSelected: boolean, isCompleted?: boolean) {
  if (isCompleted) {
    if (isReward) {
      return cn(
        "border border-slate-300 bg-sky-50/60 text-slate-700 transition-colors",
        isSelected && "font-medium ring-2 ring-blue-500",
      )
    }
    return cn(
      "border border-zinc-300 bg-zinc-100 text-zinc-700 transition-colors hover:bg-zinc-200/80",
      isSelected ? "font-medium ring-2 ring-blue-500" : "",
    )
  }
  if (isReward) {
    return cn(
      "border border-sky-300 bg-sky-50 text-sky-900 transition-colors hover:bg-sky-100/90",
      isSelected && "font-medium ring-2 ring-blue-500",
    )
  }
  return cn(
    "border border-transparent transition-colors",
    isSelected
      ? "bg-primary/12 font-medium text-primary ring-1 ring-primary/25"
      : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
  )
}

function orderTasksByPrerequisites<T extends { id: string }>(
  tasks: T[],
  deps: Array<{ source_task_id: string; target_task_id: string }>,
): T[] {
  if (tasks.length <= 1) return tasks
  const taskIds = new Set(tasks.map((t) => t.id))
  const indegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()
  const originalIndex = new Map<string, number>()

  tasks.forEach((task, index) => {
    indegree.set(task.id, 0)
    adjacency.set(task.id, [])
    originalIndex.set(task.id, index)
  })

  deps.forEach((dep) => {
    if (!taskIds.has(dep.source_task_id) || !taskIds.has(dep.target_task_id)) return
    adjacency.get(dep.source_task_id)?.push(dep.target_task_id)
    indegree.set(dep.target_task_id, (indegree.get(dep.target_task_id) ?? 0) + 1)
  })

  const queue = tasks
    .filter((task) => (indegree.get(task.id) ?? 0) === 0)
    .sort((a, b) => (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0))

  const ordered: T[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    ordered.push(current)

    const neighbors = adjacency.get(current.id) ?? []
    neighbors.forEach((neighborId) => {
      const next = (indegree.get(neighborId) ?? 0) - 1
      indegree.set(neighborId, next)
      if (next === 0) {
        const neighborTask = tasks.find((task) => task.id === neighborId)
        if (neighborTask) {
          queue.push(neighborTask)
          queue.sort((a, b) => (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0))
        }
      }
    })
  }

  if (ordered.length === tasks.length) return ordered
  const orderedSet = new Set(ordered.map((task) => task.id))
  return [...ordered, ...tasks.filter((task) => !orderedSet.has(task.id))]
}

function orderOccurrenceTasksForSidebar(
  tasks: OccurrenceTaskListItem[],
  deps: Array<{ source_task_id: string; target_task_id: string }>,
): OccurrenceTaskListItem[] {
  const topo = orderTasksByPrerequisites<OccurrenceTaskListItem>(tasks, deps)
  const rank = (status: OccurrenceTaskListItem["status"]) => {
    if (status === "completed") return 0
    if (status === "unlocked") return 1
    return 2 // locked
  }
  return [...topo].sort((a, b) => rank(a.status) - rank(b.status))
}

const WEEKDAY_OPTIONS: Array<{ value: Weekday; label: string }> = [
  { value: "sunday", label: "Sunday" },
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
]
const MONTHLY_NTH_OPTIONS: MonthlyNth[] = ["1st", "2nd", "3rd", "4th", "last"]
const YEARLY_NTH_OPTIONS = ["last", ...Array.from({ length: 52 }, (_, index) => `${index + 1}th`)] as const

function formatRecurrencePreview(value: Date | null) {
  if (!value) return "Next recurrence: unavailable"
  return `Next recurrence: ${value.toLocaleString("en-AU", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`
}

function todayDateInputValue() {
  const now = new Date()
  const y = String(now.getFullYear())
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

/** Default task card size (matches TaskNode) when React Flow has not measured yet. */
const TASK_NODE_FALLBACK_W = 220
const TASK_NODE_FALLBACK_H = 132
/** Max distance (flow coordinates) from pointer to dependency edge for “insert into chain”. */
const INSERT_EDGE_HIT_MAX = 42

function calculateBezierControlOffset(distance: number, curvature: number) {
  if (distance >= 0) {
    return 0.5 * distance
  }
  return curvature * 25 * Math.sqrt(-distance)
}

function getBezierControlWithCurvature(opts: {
  pos: Position
  x1: number
  y1: number
  x2: number
  y2: number
  c: number
}): [number, number] {
  const { pos, x1, y1, x2, y2, c } = opts
  switch (pos) {
    case Position.Left:
      return [x1 - calculateBezierControlOffset(x1 - x2, c), y1]
    case Position.Right:
      return [x1 + calculateBezierControlOffset(x2 - x1, c), y1]
    case Position.Top:
      return [x1, y1 - calculateBezierControlOffset(y1 - y2, c)]
    case Position.Bottom:
      return [x1, y1 + calculateBezierControlOffset(y2 - y1, c)]
    default:
      return [x1, y1]
  }
}

function cubicBezierMinDistSq(
  px: number,
  py: number,
  p0x: number,
  p0y: number,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
  samples = 48,
) {
  let minSq = Infinity
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const mt = 1 - t
    const x =
      mt * mt * mt * p0x + 3 * mt * mt * t * p1x + 3 * mt * t * t * p2x + t * t * t * p3x
    const y =
      mt * mt * mt * p0y + 3 * mt * mt * t * p1y + 3 * mt * t * t * p2y + t * t * t * p3y
    const dx = px - x
    const dy = py - y
    const sq = dx * dx + dy * dy
    if (sq < minSq) minSq = sq
  }
  return minSq
}

function minDistSqToDefaultTaskEdge(
  fx: number,
  fy: number,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
) {
  const curvature = 0.25
  const [scx, scy] = getBezierControlWithCurvature({
    pos: Position.Bottom,
    x1: sourceX,
    y1: sourceY,
    x2: targetX,
    y2: targetY,
    c: curvature,
  })
  const [tcx, tcy] = getBezierControlWithCurvature({
    pos: Position.Top,
    x1: targetX,
    y1: targetY,
    x2: sourceX,
    y2: sourceY,
    c: curvature,
  })
  return cubicBezierMinDistSq(fx, fy, sourceX, sourceY, scx, scy, tcx, tcy, targetX, targetY)
}

function taskNodeMeasuredSize(n: Node) {
  const w = n.measured?.width ?? n.width ?? TASK_NODE_FALLBACK_W
  const h = n.measured?.height ?? n.height ?? TASK_NODE_FALLBACK_H
  return { w, h }
}

function findInsertHoverEdgeId(
  rf: ReactFlowInstance,
  edges: Edge[],
  draggingTaskId: string,
  clientX: number,
  clientY: number,
  maxDist: number,
): string | null {
  const p = rf.screenToFlowPosition({ x: clientX, y: clientY })
  let bestId: string | null = null
  let bestSq = maxDist * maxDist
  for (const edge of edges) {
    if (edge.source === draggingTaskId || edge.target === draggingTaskId) continue
    const sn = rf.getNode(edge.source)
    const tn = rf.getNode(edge.target)
    if (!sn || !tn) continue
    if (sn.type === "dayDivider" || tn.type === "dayDivider") continue
    const sw = taskNodeMeasuredSize(sn).w
    const sh = taskNodeMeasuredSize(sn).h
    const tw = taskNodeMeasuredSize(tn).w
    const th = taskNodeMeasuredSize(tn).h
    const sx = sn.position.x + sw / 2
    const sy = sn.position.y + sh
    const tx = tn.position.x + tw / 2
    const ty = tn.position.y
    const dSq = minDistSqToDefaultTaskEdge(p.x, p.y, sx, sy, tx, ty)
    if (dSq < bestSq) {
      bestSq = dSq
      bestId = edge.id
    }
  }
  return bestId
}

export function LeaderFlowEditor({
  households,
  selectedHouseholdId,
  selectedRoutineId: initialSelectedRoutineId,
  routines,
  tasks,
  dependencies,
  members,
  allTasks,
  invites,
  occurrences,
  selectedOccurrenceId: initialSelectedOccurrenceId,
  occurrenceTaskStatuses,
  taskAssignees,
  templateTaskAssignees,
}: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [localRoutines, setLocalRoutines] = useState<Routine[]>(routines)
  const [localMembers, setLocalMembers] = useState<Member[]>(members)
  const [localTasks, setLocalTasks] = useState<Task[]>(tasks)
  const [localAllTasks, setLocalAllTasks] = useState<TaskListItem[]>(allTasks)
  const [localDeps, setLocalDeps] = useState<Dependency[]>(dependencies)
  const [localInvites, setLocalInvites] = useState<HouseholdInvite[]>(invites)
  const [localOccurrences, setLocalOccurrences] = useState<RoutineOccurrence[]>(occurrences)
  const [localOccurrenceTaskStatuses, setLocalOccurrenceTaskStatuses] =
    useState<OccurrenceTaskStatus[]>(occurrenceTaskStatuses)
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(initialSelectedRoutineId)
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState<string | null>(initialSelectedOccurrenceId)
  const [localTaskAssignees, setLocalTaskAssignees] = useState<TaskAssignee[]>(taskAssignees)
  const [localTemplateTaskAssignees, setLocalTemplateTaskAssignees] =
    useState<TaskAssignee[]>(templateTaskAssignees)
  const [activeTask, setActiveTask] = useState<Task | null>(null)
  const [unlockModeSelection, setUnlockModeSelection] = useState<string>("none")
  const [expiryModeSelection, setExpiryModeSelection] = useState<string>("none")
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [edgeMenu, setEdgeMenu] = useState<EdgeMenuState | null>(null)
  const [occurrenceMenu, setOccurrenceMenu] = useState<OccurrenceMenuState | null>(null)
  const [taskMenu, setTaskMenu] = useState<TaskMenuState | null>(null)
  const [routinePlusMenu, setRoutinePlusMenu] = useState<RoutinePlusMenuState | null>(null)
  const [expandedRecurrenceRuleIds, setExpandedRecurrenceRuleIds] = useState<Record<string, boolean>>({})
  const [expandedOccurrenceTaskSectionIds, setExpandedOccurrenceTaskSectionIds] = useState<
    Record<string, boolean>
  >({})
  const [hideCompletedTasks, setHideCompletedTasks] = useState(false)
  const [occurrenceTaskLists, setOccurrenceTaskLists] = useState<Record<string, OccurrenceTaskListItem[]>>({})
  const [occurrenceTaskListsLoading, setOccurrenceTaskListsLoading] = useState<Record<string, boolean>>({})
  const [occurrenceDeleteConfirm, setOccurrenceDeleteConfirm] = useState<{
    occurrenceId: string
    routineId?: string
  } | null>(null)
  const [guideLineMenu, setGuideLineMenu] = useState<{ nodeId: string; x: number; y: number } | null>(
    null,
  )
  const [guidePlaceMode, setGuidePlaceMode] = useState<GuidePlaceMode | null>(null)
  const [guidePreviewFlow, setGuidePreviewFlow] = useState<{ x: number; y: number } | null>(null)
  const [guidePreviewScreen, setGuidePreviewScreen] = useState<{ x: number; y: number } | null>(null)
  const [editingGuideId, setEditingGuideId] = useState<string | null>(null)
  const [editingGuideValue, setEditingGuideValue] = useState("")
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null)
  const [editingRoutineValue, setEditingRoutineValue] = useState("")
  const [editingBoardId, setEditingBoardId] = useState<string | null>(null)
  const [editingBoardValue, setEditingBoardValue] = useState("")
  const [editingMemberNameId, setEditingMemberNameId] = useState<string | null>(null)
  const [editingMemberNameValue, setEditingMemberNameValue] = useState("")
  const [serverClockOffsetMs, setServerClockOffsetMs] = useState(0)
  const [taskSettingsSaveState, setTaskSettingsSaveState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  )
  const [taskSettingsSaveError, setTaskSettingsSaveError] = useState<string | null>(null)
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)
  const flowSectionRef = useRef<HTMLElement | null>(null)
  const householdPanelRef = useRef<HTMLElement | null>(null)
  const householdPanelToggleRef = useRef<HTMLButtonElement | null>(null)
  const taskSettingsFormRef = useRef<HTMLFormElement | null>(null)
  const taskSettingsAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const taskSettingsSaveRequestIdRef = useRef(0)
  const activeTaskForSettingsRef = useRef<Task | null>(null)
  activeTaskForSettingsRef.current = activeTask
  const flushTaskSettingsIfDirtyRef = useRef<() => Promise<void>>(async () => {})
  const recurrenceSaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout> | null>>({})
  const guideStorageKeyMemo = useMemo(
    () => guideStorageKey(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId),
    [selectedHouseholdId, selectedRoutineId, selectedOccurrenceId],
  )
  const lastManagementSelectionKeyMemo = useMemo(
    () => lastManagementSelectionKey(selectedHouseholdId),
    [selectedHouseholdId],
  )
  const [expandedRoutineIds, setExpandedRoutineIds] = useState<Record<string, boolean>>(
    selectedRoutineId ? { [selectedRoutineId]: true } : {},
  )
  const [expandedTemplateSectionIds, setExpandedTemplateSectionIds] = useState<Record<string, boolean>>(
    {},
  )
  const [isHouseholdPanelOpen, setIsHouseholdPanelOpen] = useState(false)
  const memberTokenColorMap = useMemo(() => buildMemberTokenColorMap(localMembers), [localMembers])
  const selectedHouseholdLeaderId = useMemo(
    () => households.find((household) => household.id === selectedHouseholdId)?.leader_id ?? "",
    [households, selectedHouseholdId],
  )
  const routineNameById = useMemo(
    () => new Map(localRoutines.map((routine) => [routine.id, routine.name])),
    [localRoutines],
  )
  const selectedRoutine = useMemo(
    () => localRoutines.find((routine) => routine.id === selectedRoutineId) ?? null,
    [localRoutines, selectedRoutineId],
  )
  const selectedRoutineRecurrenceRules = useMemo(
    () => parseRoutineRecurrenceRules(selectedRoutine?.recurrence_rule),
    [selectedRoutine?.recurrence_rule],
  )
  const taskBoards = useMemo(() => {
    const rows = [...localOccurrences]
    rows.sort((a, b) => {
      const aCompleted = a.total_tasks > 0 && a.completed_tasks >= a.total_tasks
      const bCompleted = b.total_tasks > 0 && b.completed_tasks >= b.total_tasks
      if (aCompleted !== bCompleted) return aCompleted ? 1 : -1
      return new Date(b.scheduled_for).getTime() - new Date(a.scheduled_for).getTime()
    })
    return rows.filter((board) => {
      if (!hideCompletedTasks) return true
      return !(board.total_tasks > 0 && board.completed_tasks >= board.total_tasks)
    })
  }, [localOccurrences, hideCompletedTasks])

  useEffect(() => {
    if (!isHouseholdPanelOpen) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null
      if (!target) return
      if (householdPanelRef.current?.contains(target)) return
      if (householdPanelToggleRef.current?.contains(target)) return
      setIsHouseholdPanelOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
    }
  }, [isHouseholdPanelOpen])

  const buildLockTooltip = useCallback(
    (
      task: Task,
      occurrenceStatus: string,
      dependencyRows: Dependency[],
      statusByTaskId: Map<string, "locked" | "unlocked" | "completed">,
    ) => {
      if (occurrenceStatus !== "locked") return null
      const blockedByPrereq = dependencyRows.some(
        (dep) => dep.target_task_id === task.id && statusByTaskId.get(dep.source_task_id) !== "completed",
      )
      if (blockedByPrereq) return "Locked by prerequisites"
      if (task.unlock_at) {
        const unlockAt = new Date(task.unlock_at)
        const date = unlockAt.toLocaleDateString("en-AU")
        const time = unlockAt.toLocaleTimeString("en-AU", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
        return `Locked, unlocks at ${date} ${time}`
      }
      return "Locked"
    },
    [],
  )

  const getOrderedTasksForRoutine = (routineId: string) => {
    const routineTasks = localAllTasks.filter((task) => task.routine_id === routineId)
    if (routineTasks.length <= 1) return routineTasks

    const taskIds = new Set(routineTasks.map((task) => task.id))
    const indegree = new Map<string, number>()
    const adjacency = new Map<string, string[]>()
    const originalIndex = new Map<string, number>()

    routineTasks.forEach((task, index) => {
      indegree.set(task.id, 0)
      adjacency.set(task.id, [])
      originalIndex.set(task.id, index)
    })

    localDeps.forEach((dep) => {
      if (!taskIds.has(dep.source_task_id) || !taskIds.has(dep.target_task_id)) return
      adjacency.get(dep.source_task_id)?.push(dep.target_task_id)
      indegree.set(dep.target_task_id, (indegree.get(dep.target_task_id) ?? 0) + 1)
    })

    const queue = routineTasks
      .filter((task) => (indegree.get(task.id) ?? 0) === 0)
      .sort((a, b) => (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0))

    const ordered: TaskListItem[] = []
    while (queue.length > 0) {
      const current = queue.shift()!
      ordered.push(current)

      const neighbors = adjacency.get(current.id) ?? []
      neighbors.forEach((neighborId) => {
        const next = (indegree.get(neighborId) ?? 0) - 1
        indegree.set(neighborId, next)
        if (next === 0) {
          const neighborTask = routineTasks.find((task) => task.id === neighborId)
          if (neighborTask) {
            queue.push(neighborTask)
            queue.sort(
              (a, b) => (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0),
            )
          }
        }
      })
    }

    if (ordered.length === routineTasks.length) return ordered

    const orderedSet = new Set(ordered.map((task) => task.id))
    const remaining = routineTasks.filter((task) => !orderedSet.has(task.id))
    return [...ordered, ...remaining]
  }

  const renderSidebarAssigneeTokens = (assigneeIds: string[]) => {
    const assignees = assigneeIds
      .map((id) => localMembers.find((member) => member.id === id))
      .map((member) =>
        member
          ? { ...member, tokenColorClass: memberTokenColorMap.get(member.id) }
          : null,
      )
      .filter(Boolean) as Member[]
    if (assignees.length === 0) return null
    const visible = assignees.slice(0, 4)
    const overflow = assignees.length - visible.length

    return (
      <div className="flex shrink-0 items-center -space-x-2">
        {visible.map((assignee) =>
                  isRenderableUserProfilePhotoUrl(assignee.avatar_url) && !assignee.token_color ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={assignee.id}
              src={assignee.avatar_url!}
              alt={assignee.name}
              className="h-4 w-4 rounded-full border border-white object-cover"
              title={assignee.name}
            />
          ) : (
            <span
              key={assignee.id}
              className={`inline-flex h-4 w-4 items-center justify-center rounded-full border border-white text-[8px] font-semibold ${
                assignee.tokenColorClass ?? memberColorFor(assignee.id)
              }`}
              title={assignee.name}
            >
              {memberInitials(assignee.name)}
            </span>
          ),
        )}
        {overflow > 0 ? (
          <span
            className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-white bg-zinc-200 text-[8px] font-semibold text-zinc-700"
            title={`${overflow} more assignees`}
          >
            +{overflow}
          </span>
        ) : null}
      </div>
    )
  }

  const reloadFlowRef = useRef<
    (householdId: string, routineId?: string | null, occurrenceId?: string | null) => Promise<void>
  >(async () => {})
  const latestReloadRequestIdRef = useRef(0)

  const occurrenceCtxRef = useRef({
    householdId: selectedHouseholdId,
    routineId: selectedRoutineId as string | null,
    occurrenceId: selectedOccurrenceId as string | null,
  })
  occurrenceCtxRef.current = {
    householdId: selectedHouseholdId,
    routineId: selectedRoutineId,
    occurrenceId: selectedOccurrenceId,
  }

  const syncRoute = (
    householdId: string,
    routineId?: string | null,
    occurrenceId?: string | null,
  ) => {
    const nextRoutineId = routineId ?? null
    const nextOccurrenceId = occurrenceId ?? null
    setSelectedRoutineId(nextRoutineId)
    setSelectedOccurrenceId(nextOccurrenceId)
    const params = new URLSearchParams()
    params.set("household", householdId)
    if (nextRoutineId) params.set("routine", nextRoutineId)
    if (nextOccurrenceId) params.set("occurrence", nextOccurrenceId)
    const nextHref = `/leader/dashboard?${params.toString()}`
    if (typeof window !== "undefined") {
      const currentHref = `${window.location.pathname}${window.location.search}`
      if (currentHref === nextHref) return
      window.history.replaceState(window.history.state, "", nextHref)
      return
    }
    router.replace(nextHref, { scroll: false })
  }

  const handleOccurrenceToggle = useCallback((taskId: string, completed: boolean) => {
    const { householdId, routineId, occurrenceId } = occurrenceCtxRef.current
    if (!occurrenceId) return
    void (async () => {
      const res = await fetch("/api/leader/flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "setOccurrenceTaskCompleted",
          householdId,
          occurrenceId,
          taskId,
          completed,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
        }),
      })
      if (res.ok) {
        await reloadFlowRef.current(householdId, routineId, occurrenceId)
      }
    })()
  }, [])

  const reloadFlow = async (
    householdId: string,
    routineId?: string | null,
    occurrenceId?: string | null,
  ) => {
    const requestId = ++latestReloadRequestIdRef.current
    const query = new URLSearchParams({ householdId })
    query.set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC")
    if (routineId) query.set("routineId", routineId)
    if (occurrenceId) query.set("occurrenceId", occurrenceId)
    const response = await fetch(`/api/leader/flow?${query.toString()}`)
    if (response.status === 404 && occurrenceId) {
      saveLastManagementSelection(lastManagementSelectionKeyMemo, {
        routineId: routineId ?? null,
        occurrenceId: null,
      })
      syncRoute(householdId, routineId ?? null, null)
      await reloadFlow(householdId, routineId ?? null, null)
      return
    }
    if (!response.ok) return
    const json = await response.json()
    if (requestId !== latestReloadRequestIdRef.current) return
    if (json.serverNow) {
      const serverNowMs = new Date(String(json.serverNow)).getTime()
      if (Number.isFinite(serverNowMs)) {
        setServerClockOffsetMs(Date.now() - serverNowMs)
      }
    }
    setLocalRoutines(json.routines ?? [])
    setLocalMembers(json.members ?? [])
    setLocalTasks(json.tasks ?? [])
    setLocalAllTasks(json.allTasks ?? [])
    setLocalDeps(json.dependencies ?? [])
    setLocalInvites(json.invites ?? [])
    setLocalOccurrences(json.occurrences ?? [])
    setLocalOccurrenceTaskStatuses(json.occurrenceTaskStatuses ?? [])
    setLocalTaskAssignees(json.taskAssignees ?? [])
    setLocalTemplateTaskAssignees(json.templateTaskAssignees ?? json.taskAssignees ?? [])
    if (occurrenceId) {
      const statusByTaskId = new Map<string, "locked" | "unlocked" | "completed">(
        (json.occurrenceTaskStatuses ?? []).map((item: { task_id: string; status: string }) => [
          item.task_id,
          item.status as "locked" | "unlocked" | "completed",
        ]),
      )
      const orderedTasks = orderOccurrenceTasksForSidebar(
        (json.tasks ?? []).map((task: Task) => ({
          id: task.id,
          title: task.title,
          status:
            statusByTaskId.get(task.id) ?? (task.status as "locked" | "unlocked" | "completed"),
          assignee_ids: (json.taskAssignees ?? [])
            .filter((assignment: TaskAssignee) => assignment.task_id === task.id)
            .map((assignment: TaskAssignee) => assignment.user_id),
          is_reward: task.is_reward,
        })) as OccurrenceTaskListItem[],
        (json.dependencies ?? []) as Array<{ source_task_id: string; target_task_id: string }>,
      )
      setOccurrenceTaskLists((prev) => ({
        ...prev,
        [occurrenceId]: orderedTasks,
      }))
    }
    const guideKey = guideStorageKey(householdId, routineId ?? null, occurrenceId ?? null)
    setFlowNodes((prevNodes) => {
      const fetchedMembers = (json.members ?? []) as Member[]
      const colorMap = buildMemberTokenColorMap(fetchedMembers)
      const statusByTaskId = new Map<string, "locked" | "unlocked" | "completed">(
        (json.occurrenceTaskStatuses ?? []).map((item: { task_id: string; status: string }) => [
          item.task_id,
          item.status as "locked" | "unlocked" | "completed",
        ]),
      )
      const taskNodes = (json.tasks ?? []).map((task: Task, index: number) => {
        const existing = prevNodes.find((node) => node.id === task.id)
        const ots = json.occurrenceTaskStatuses ?? []
        const occRow = ots.find((item: OccurrenceTaskStatus) => item.task_id === task.id)
        const occurrenceStatus = occRow?.status ?? task.status
        const isOcc = Boolean(occurrenceId)
        return {
          id: task.id,
          type: "taskNode" as const,
          draggable: existing?.draggable ?? true,
          selected: existing?.selected ?? false,
          position:
            existing?.position ?? {
              x: task.position_x ?? 80 + (index % 4) * 280,
              y: task.position_y ?? 80 + Math.floor(index / 4) * 170,
            },
          zIndex: 1,
          data: {
            title: task.title,
            status: occurrenceStatus,
            isReward: task.is_reward,
            highlighted: selectedTaskId === task.id,
            assignees: (json.taskAssignees ?? [])
              .filter((assignment: TaskAssignee) => assignment.task_id === task.id)
              .map((assignment: TaskAssignee) => {
                const member = fetchedMembers.find((m) => m.id === assignment.user_id)
                return member
                  ? { ...member, tokenColorClass: colorMap.get(member.id) }
                  : null
              })
              .filter(Boolean) as Member[],
            occurrenceView: isOcc,
            occurrenceStatus,
            lockTooltip: isOcc
              ? buildLockTooltip(
                  task,
                  occurrenceStatus,
                  (json.dependencies ?? []) as Dependency[],
                  statusByTaskId,
                )
              : null,
            onToggleOccurrenceComplete: isOcc
              ? () => {
                  handleOccurrenceToggle(task.id, occurrenceStatus !== "completed")
                }
              : undefined,
          },
        }
      })
      return mergeTaskNodesWithGuides(guideKey, taskNodes)
    })
    setFlowEdges(
      (json.dependencies ?? []).map((dep: Dependency) => ({
        id: `${dep.source_task_id}-${dep.target_task_id}`,
        source: dep.source_task_id,
        target: dep.target_task_id,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    )
  }
  reloadFlowRef.current = reloadFlow

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
  }, [selectedHouseholdId, selectedRoutineId, selectedOccurrenceId])

  useEffect(() => {
    setSelectedRoutineId(initialSelectedRoutineId)
    setSelectedOccurrenceId(initialSelectedOccurrenceId)
  }, [initialSelectedRoutineId, initialSelectedOccurrenceId])

  useEffect(() => {
    if (!selectedRoutineId && !selectedOccurrenceId) return
    saveLastManagementSelection(lastManagementSelectionKeyMemo, {
      routineId: selectedRoutineId,
      occurrenceId: selectedOccurrenceId,
    })
  }, [lastManagementSelectionKeyMemo, selectedRoutineId, selectedOccurrenceId])

  useEffect(() => {
    if (selectedRoutineId || selectedOccurrenceId) return
    const stored = loadLastManagementSelection(lastManagementSelectionKeyMemo)
    const incompleteBoards = taskBoards.filter(
      (board) => !(board.total_tasks > 0 && board.completed_tasks >= board.total_tasks),
    )
    if (stored?.occurrenceId) {
      const storedBoard = incompleteBoards.find((board) => board.id === stored.occurrenceId)
      if (storedBoard) {
        syncRoute(selectedHouseholdId, storedBoard.routine_id ?? stored.routineId ?? null, storedBoard.id)
        return
      }
    }
    if (stored?.routineId && localRoutines.some((routine) => routine.id === stored.routineId)) {
      syncRoute(selectedHouseholdId, stored.routineId, null)
      return
    }
    const firstBoard = incompleteBoards[0] ?? taskBoards[0]
    if (firstBoard) {
      syncRoute(selectedHouseholdId, firstBoard.routine_id ?? null, firstBoard.id)
      return
    }
    const firstRoutine = localRoutines[0]
    if (firstRoutine) {
      syncRoute(selectedHouseholdId, firstRoutine.id, null)
    }
  }, [
    selectedRoutineId,
    selectedOccurrenceId,
    taskBoards,
    localRoutines,
    selectedHouseholdId,
    lastManagementSelectionKeyMemo,
  ])

  useEffect(() => {
    if (!selectedOccurrenceId) return
    const statusByTaskId = new Map<string, string>(
      localOccurrenceTaskStatuses.map((row) => [row.task_id, row.status]),
    )
    const hasAnyTimeEligibleLockedTask = localTasks.some((task) => {
      const status = statusByTaskId.get(task.id) ?? task.status
      if (status !== "locked" || !task.unlock_at) return false
      const prereqRows = localDeps.filter((dep) => dep.target_task_id === task.id)
      const hasPrereq = prereqRows.length > 0
      const hasUnsatisfiedPrereq = prereqRows.some((dep) => {
        const sourceStatus = statusByTaskId.get(dep.source_task_id) ?? "locked"
        return sourceStatus !== "completed"
      })
      const combiner = task.unlock_combiner ?? "and"
      if (!hasPrereq) return true
      if (combiner === "or") return true
      // AND mode still needs periodic unlock checks once prerequisites are complete.
      return !hasUnsatisfiedPrereq
    })
    const hasAnyExpiryCandidate = localTasks.some((task) => {
      const status = statusByTaskId.get(task.id) ?? task.status
      if (!task.expires_at) return false
      return status !== "completed"
    })
    if (!hasAnyTimeEligibleLockedTask && !hasAnyExpiryCandidate) return

    const candidateInstantsMs: number[] = []
    for (const task of localTasks) {
      const status = statusByTaskId.get(task.id) ?? task.status
      if (status === "completed") continue
      if (task.expires_at) {
        const expiresMs = new Date(task.expires_at).getTime()
        if (!Number.isNaN(expiresMs)) candidateInstantsMs.push(expiresMs)
      }
      if (status === "locked" && task.unlock_at) {
        const unlockMs = new Date(task.unlock_at).getTime()
        if (!Number.isNaN(unlockMs)) candidateInstantsMs.push(unlockMs)
      }
    }

    let timeoutId: number | null = null
    let cancelled = false
    const scheduleNextPoll = () => {
      if (cancelled) return
      const nowMsByServerClock = Date.now() - serverClockOffsetMs
      const now = new Date(nowMsByServerClock)
      const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 10
      const msUntilNearestInstant = candidateInstantsMs
        .map((instantMs) => instantMs - nowMsByServerClock + 25)
        .filter((delta) => delta > 0)
        .reduce((min, delta) => Math.min(min, delta), Number.POSITIVE_INFINITY)
      const nextDelay =
        Number.isFinite(msUntilNearestInstant)
          ? Math.max(10, Math.min(msUntilNextMinute, msUntilNearestInstant))
          : Math.max(10, msUntilNextMinute)
      timeoutId = window.setTimeout(() => {
        void reloadFlowRef.current(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
        scheduleNextPoll()
      }, nextDelay)
    }
    scheduleNextPoll()

    return () => {
      cancelled = true
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }
  }, [
    selectedHouseholdId,
    selectedRoutineId,
    selectedOccurrenceId,
    localTasks,
    localDeps,
    localOccurrenceTaskStatuses,
    serverClockOffsetMs,
  ])

  useEffect(() => {
    if (selectedOccurrenceId) return
    if (!selectedRoutineId) return
    if (selectedRoutineRecurrenceRules.length === 0) return

    let timeoutId: number | null = null
    let cancelled = false
    const scheduleNextPoll = () => {
      if (cancelled) return
      const nowMsByServerClock = Date.now() - serverClockOffsetMs
      const now = new Date(nowMsByServerClock)
      const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 10
      timeoutId = window.setTimeout(() => {
        void reloadFlowRef.current(selectedHouseholdId, selectedRoutineId, null)
        scheduleNextPoll()
      }, Math.max(10, msUntilNextMinute))
    }
    scheduleNextPoll()
    return () => {
      cancelled = true
      if (timeoutId !== null) window.clearTimeout(timeoutId)
    }
  }, [
    selectedOccurrenceId,
    selectedRoutineId,
    selectedRoutineRecurrenceRules,
    selectedHouseholdId,
    serverClockOffsetMs,
  ])

  /** Occurrence boards do not use the routine “next minute” poll above; still refetch so other members’ completions update the canvas. */
  useEffect(() => {
    if (!selectedOccurrenceId) return
    const pollMs = 15_000
    const tick = () => {
      void reloadFlowRef.current(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
    }
    const intervalId = window.setInterval(tick, pollMs)
    const onVisibility = () => {
      if (document.visibilityState === "visible") void tick()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [selectedHouseholdId, selectedRoutineId, selectedOccurrenceId])

  useEffect(() => {
    setLocalRoutines(routines)
    setLocalMembers(members)
    setLocalTasks(tasks)
    setLocalAllTasks(allTasks)
    setLocalDeps(dependencies)
    setLocalInvites(invites)
    setLocalOccurrences(occurrences)
    setLocalOccurrenceTaskStatuses(occurrenceTaskStatuses)
    setLocalTaskAssignees(taskAssignees)
    setLocalTemplateTaskAssignees(templateTaskAssignees)
    if (selectedOccurrenceId) {
      const statusByTaskId = new Map<string, "locked" | "unlocked" | "completed">(
        occurrenceTaskStatuses.map((item) => [
          item.task_id,
          item.status as "locked" | "unlocked" | "completed",
        ]),
      )
      const orderedTasks = orderOccurrenceTasksForSidebar(
        tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status:
            statusByTaskId.get(task.id) ?? (task.status as "locked" | "unlocked" | "completed"),
          assignee_ids: taskAssignees
            .filter((assignment) => assignment.task_id === task.id)
            .map((assignment) => assignment.user_id),
          is_reward: task.is_reward,
        })) as OccurrenceTaskListItem[],
        dependencies,
      )
      setOccurrenceTaskLists((prev) => ({
        ...prev,
        [selectedOccurrenceId]: orderedTasks,
      }))
    }
    const gKey = guideStorageKey(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
    setFlowNodes((prevNodes) => {
      const colorMap = buildMemberTokenColorMap(members)
      const statusByTaskId = new Map<string, "locked" | "unlocked" | "completed">(
        occurrenceTaskStatuses.map((item) => [item.task_id, item.status as "locked" | "unlocked" | "completed"]),
      )
      const taskNodes = tasks.map((task, index) => {
        const existing = prevNodes.find((node) => node.id === task.id)
        const occRow = occurrenceTaskStatuses.find((item) => item.task_id === task.id)
        const occurrenceStatus = occRow?.status ?? task.status
        const isOcc = Boolean(selectedOccurrenceId)
        return {
          id: task.id,
          type: "taskNode" as const,
          draggable: existing?.draggable ?? true,
          selected: existing?.selected ?? false,
          position:
            existing?.position ?? {
              x: task.position_x ?? 80 + (index % 4) * 280,
              y: task.position_y ?? 80 + Math.floor(index / 4) * 170,
            },
          zIndex: 1,
          data: {
            title: task.title,
            status: occurrenceStatus,
            isReward: task.is_reward,
            highlighted: false,
            assignees: taskAssignees
              .filter((assignment) => assignment.task_id === task.id)
              .map((assignment) => {
                const member = members.find((m) => m.id === assignment.user_id)
                return member
                  ? { ...member, tokenColorClass: colorMap.get(member.id) }
                  : null
              })
              .filter(Boolean) as Member[],
            occurrenceView: isOcc,
            occurrenceStatus,
            lockTooltip: isOcc ? buildLockTooltip(task, occurrenceStatus, dependencies, statusByTaskId) : null,
            onToggleOccurrenceComplete: isOcc
              ? () => {
                  handleOccurrenceToggle(task.id, occurrenceStatus !== "completed")
                }
              : undefined,
          },
        }
      })
      return mergeTaskNodesWithGuides(gKey, taskNodes)
    })
    setFlowEdges(
      dependencies.map((dep) => ({
        id: `${dep.source_task_id}-${dep.target_task_id}`,
        source: dep.source_task_id,
        target: dep.target_task_id,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    )
    setActiveTask(null)
    setSelectedTaskId(null)
    setEdgeMenu(null)
    setEditingGuideId(null)
  }, [
    routines,
    tasks,
    allTasks,
    dependencies,
    invites,
    occurrences,
    occurrenceTaskStatuses,
    taskAssignees,
    templateTaskAssignees,
    members,
    selectedHouseholdId,
    selectedOccurrenceId,
    selectedRoutineId,
    handleOccurrenceToggle,
  ])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest("[data-routine-plus-menu]")) return
      if (target.closest("[data-routine-plus-trigger]")) return
      if (target.closest("[data-recurrence-widget]")) return
      setRoutinePlusMenu(null)
      setExpandedRecurrenceRuleIds({})
    }
    window.addEventListener("mousedown", onPointerDown)
    return () => window.removeEventListener("mousedown", onPointerDown)
  }, [])

  useEffect(() => {
    return () => {
      for (const timer of Object.values(recurrenceSaveTimersRef.current)) {
        if (timer) clearTimeout(timer)
      }
    }
  }, [])

  const nodes: Node[] = useMemo(
    () =>
      localTasks.map((task, index) => {
        const occurrenceRow = localOccurrenceTaskStatuses.find((item) => item.task_id === task.id)
        const occurrenceStatus = occurrenceRow?.status ?? task.status
        const isOcc = Boolean(selectedOccurrenceId)
        const statusByTaskId = new Map<string, "locked" | "unlocked" | "completed">(
          localOccurrenceTaskStatuses.map((item) => [
            item.task_id,
            item.status as "locked" | "unlocked" | "completed",
          ]),
        )
        return {
          id: task.id,
          type: "taskNode",
          position: {
            x: task.position_x ?? 80 + (index % 4) * 280,
            y: task.position_y ?? 80 + Math.floor(index / 4) * 170,
          },
          zIndex: 1,
          data: {
            title: task.title,
            status: occurrenceStatus,
            isReward: task.is_reward,
            highlighted: selectedTaskId === task.id,
            assignees: localTaskAssignees
              .filter((assignment) => assignment.task_id === task.id)
              .map((assignment) => {
                const member = localMembers.find((m) => m.id === assignment.user_id)
                return member
                  ? { ...member, tokenColorClass: memberTokenColorMap.get(member.id) }
                  : null
              })
              .filter(Boolean) as Member[],
            occurrenceView: isOcc,
            occurrenceStatus,
            lockTooltip: isOcc ? buildLockTooltip(task, occurrenceStatus, localDeps, statusByTaskId) : null,
            onToggleOccurrenceComplete: isOcc
              ? () => {
                  handleOccurrenceToggle(task.id, occurrenceStatus !== "completed")
                }
              : undefined,
          },
        }
      }),
    [
      localTasks,
      selectedTaskId,
      localOccurrenceTaskStatuses,
      localTaskAssignees,
      localMembers,
      memberTokenColorMap,
      selectedOccurrenceId,
      handleOccurrenceToggle,
      localDeps,
      buildLockTooltip,
    ],
  )

  const initialEdges: Edge[] = useMemo(
    () =>
      localDeps.map((dep) => ({
        id: `${dep.source_task_id}-${dep.target_task_id}`,
        source: dep.source_task_id,
        target: dep.target_task_id,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [localDeps],
  )

  const [flowNodes, setFlowNodes] = useState<Node[]>(nodes)
  const [flowEdges, setFlowEdges] = useState(initialEdges)
  const [insertHoverEdgeId, setInsertHoverEdgeId] = useState<string | null>(null)
  const insertHoverEdgeIdRef = useRef<string | null>(null)

  useEffect(() => {
    setFlowNodes((prevNodes) => {
      const taskNodes = prevNodes.filter((node) => node.type !== "dayDivider")
      return mergeTaskNodesWithGuides(guideStorageKeyMemo, taskNodes)
    })
  }, [guideStorageKeyMemo])

  const displayEdges = useMemo(
    () =>
      flowEdges.map((edge) =>
        edge.id === insertHoverEdgeId
          ? {
              ...edge,
              style: {
                ...(edge.style && typeof edge.style === "object" ? edge.style : {}),
                strokeWidth: 4,
                stroke: "#0284c7",
              },
              zIndex: 1000,
            }
          : edge,
      ),
    [flowEdges, insertHoverEdgeId],
  )

  useEffect(() => {
    setFlowNodes((prev) =>
      prev.map((prevNode) => {
        if (prevNode.type !== "taskNode") return prevNode
        const fresh = nodes.find((n) => n.id === prevNode.id && n.type === "taskNode")
        if (!fresh) return prevNode
        return {
          ...prevNode,
          position: prevNode.position,
          data: fresh.data as TaskNodeData,
        }
      }),
    )
  }, [nodes])

  const taskClusterCenter = useMemo(() => {
    if (localTasks.length === 0) return { x: 0, y: 0 }
    const points = localTasks.map((task, index) => ({
      x: task.position_x ?? 80 + (index % 4) * 280 + 110,
      y: task.position_y ?? 80 + Math.floor(index / 4) * 170 + 60,
    }))
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    }
  }, [localTasks])

  const centerTaskInViewport = useCallback((taskId: string) => {
    if (!reactFlowRef.current) return
    const taskNode = flowNodes.find((n) => n.type === "taskNode" && n.id === taskId)
    if (!taskNode) return
    const { zoom } = reactFlowRef.current.getViewport()
    reactFlowRef.current.setCenter(taskNode.position.x + 110, taskNode.position.y + 60, {
      zoom,
      duration: 250,
    })
  }, [flowNodes])

  const displayNodes = useMemo((): Node[] => {
    const base = flowNodes.map((node) => {
      if (node.type !== "dayDivider") return node
      const nodeData = node.data as DayDividerData
      const isEditing = editingGuideId === node.id
      return {
        ...node,
        draggable: !nodeData.locked,
        data: {
          ...nodeData,
          isEditing,
          editValue: isEditing ? editingGuideValue : nodeData.label,
          onEditValueChange: isEditing ? setEditingGuideValue : undefined,
          onEditCommit: isEditing
            ? () => {
                const id = node.id
                const nextLabel = editingGuideValue.trim()
                setFlowNodes((nds) => {
                  const mapped = nds.map((n) =>
                    n.id === id && n.type === "dayDivider"
                      ? {
                          ...n,
                          data: {
                            ...(n.data as DayDividerData),
                            label: nextLabel,
                            labelOffsetX: (n.data as DayDividerData).labelOffsetX ?? 0,
                            labelOffsetY: (n.data as DayDividerData).labelOffsetY ?? 0,
                          },
                        }
                      : n,
                  )
                  saveGuideNodes(
                    guideStorageKeyMemo,
                    mapped.filter((m) => m.type === "dayDivider") as Node<DayDividerData>[],
                  )
                  return mapped
                })
                setEditingGuideId(null)
              }
            : undefined,
          onEditCancel: isEditing
            ? () => {
                setEditingGuideId(null)
              }
            : undefined,
        } satisfies DayDividerData,
      } as Node
    })

    return base
  }, [
    flowNodes,
    editingGuideId,
    editingGuideValue,
    guideStorageKeyMemo,
  ])

  const onNodesChange: OnNodesChange = (changes) => {
    const safeChanges = changes.filter(
      (ch) => !(ch.type === "remove" && "id" in ch && ch.id === "__guide_preview__"),
    )
    setFlowNodes((nds) => {
      const guides = nds.filter((n) => n.type === "dayDivider")
      const tasks = nds.filter((n) => n.type === "taskNode")
      const guideIds = new Set(guides.map((g) => g.id))
      const forGuides = safeChanges.filter((c) => "id" in c && guideIds.has(c.id as string))
      const forTasks = safeChanges.filter((c) => !("id" in c && guideIds.has(c.id as string)))
      const nextGuides = applyNodeChanges(forGuides, guides)
      const nextTasks = applyNodeChanges(forTasks, tasks)
      const merged = [...nextGuides, ...nextTasks]
      saveGuideNodes(
        guideStorageKeyMemo,
        merged.filter((n) => n.type === "dayDivider") as Node<DayDividerData>[],
      )
      return merged
    })
  }

  const onEdgesChange: OnEdgesChange = (changes) =>
    setFlowEdges((eds) => applyEdgeChanges(changes, eds))

  const clearTaskSelection = useCallback(() => {
    void (async () => {
      await flushTaskSettingsIfDirtyRef.current()
      setSelectedTaskId(null)
      setActiveTask(null)
      setFlowNodes((prev) =>
        prev.map((node) => {
          if (node.type === "dayDivider") return node
          return {
            ...node,
            data: {
              ...node.data,
              highlighted: false,
            },
          }
        }),
      )
    })()
  }, [])

  const selectedTaskNodeIds = useMemo(
    () => flowNodes.filter((node) => node.type === "taskNode" && node.selected).map((node) => node.id),
    [flowNodes],
  )
  const isTaskNodeLocked = useCallback(
    (taskId: string) =>
      flowNodes.some((node) => node.type === "taskNode" && node.id === taskId && node.draggable === false),
    [flowNodes],
  )
  const taskMenuHasLockedSelection = useMemo(
    () => (taskMenu ? taskMenu.taskIds.some((id) => isTaskNodeLocked(id)) : false),
    [isTaskNodeLocked, taskMenu],
  )
  const taskMenuAllLocked = useMemo(
    () => (taskMenu ? taskMenu.taskIds.every((id) => isTaskNodeLocked(id)) : false),
    [isTaskNodeLocked, taskMenu],
  )
  const activeTaskLocked = useMemo(
    () => (activeTask ? isTaskNodeLocked(activeTask.id) : false),
    [activeTask, isTaskNodeLocked],
  )

  const toggleTaskNodeLock = useCallback((taskIds: string[]) => {
    const ids = new Set(taskIds)
    if (ids.size === 0) return
    setFlowNodes((prev) => {
      const selectedTaskNodes = prev.filter((node) => node.type === "taskNode" && ids.has(node.id))
      const allLocked = selectedTaskNodes.length > 0 && selectedTaskNodes.every((node) => node.draggable === false)
      return prev.map((node) => {
        if (node.type !== "taskNode" || !ids.has(node.id)) return node
        return {
          ...node,
          draggable: allLocked,
        }
      })
    })
  }, [])

  const deleteTaskIds = useCallback(
    async (taskIds: string[], occurrenceId?: string | null) => {
      const uniqueTaskIds = [...new Set(taskIds)]
      if (uniqueTaskIds.length === 0) return
      await flushTaskSettingsIfDirtyRef.current()
      await Promise.all(
        uniqueTaskIds.map((taskId) =>
          fetch("/api/leader/flow", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "deleteTask",
              householdId: selectedHouseholdId,
              taskId,
              occurrenceId: occurrenceId ?? null,
            }),
          }),
        ),
      )
      setActiveTask(null)
      await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
    },
    [reloadFlow, selectedHouseholdId, selectedOccurrenceId, selectedRoutineId],
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        Boolean(target?.isContentEditable)
      if (e.key === "Escape") {
        setGuidePlaceMode(null)
        setGuidePreviewFlow(null)
        setGuidePreviewScreen(null)
        setGuideLineMenu(null)
        setEdgeMenu(null)
        setTaskMenu(null)
        setEditingGuideId(null)
        return
      }
      if (!isEditable && (e.key === "Delete" || e.key === "Backspace") && selectedTaskNodeIds.length > 0) {
        e.preventDefault()
        void deleteTaskIds(selectedTaskNodeIds, selectedOccurrenceId)
        setTaskMenu(null)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [deleteTaskIds, selectedOccurrenceId, selectedTaskNodeIds])

  useEffect(() => {
    if (!guidePlaceMode || !reactFlowRef.current) return

    const onMouseMove = (event: MouseEvent) => {
      if (!reactFlowRef.current || !flowSectionRef.current) return
      const rect = flowSectionRef.current.getBoundingClientRect()
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      if (!inside) {
        setGuidePreviewScreen(null)
        return
      }
      const p = reactFlowRef.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      setGuidePreviewFlow(p)
      setGuidePreviewScreen({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      })
    }

    window.addEventListener("mousemove", onMouseMove)
    return () => {
      window.removeEventListener("mousemove", onMouseMove)
      setGuidePreviewScreen(null)
    }
  }, [guidePlaceMode])

  const centeredRouteRef = useRef<string>("")
  useEffect(() => {
    const routeKey = `${selectedHouseholdId}:${selectedRoutineId ?? ""}:${selectedOccurrenceId ?? ""}`
    if (centeredRouteRef.current === routeKey) return
    centeredRouteRef.current = routeKey
    if (!reactFlowRef.current || localTasks.length === 0) return

    const frame = window.requestAnimationFrame(() => {
      if (!reactFlowRef.current || localTasks.length === 0) return
      const taskPositions = localTasks.map((task, index) => ({
        x: task.position_x ?? 80 + (index % 4) * 280,
        y: task.position_y ?? 80 + Math.floor(index / 4) * 170,
      }))
      const avgX = taskPositions.reduce((sum, p) => sum + p.x, 0) / taskPositions.length + 110
      const avgY = taskPositions.reduce((sum, p) => sum + p.y, 0) / taskPositions.length + 60
      const { zoom } = reactFlowRef.current.getViewport()
      reactFlowRef.current.setCenter(avgX, avgY, { zoom, duration: 250 })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [selectedHouseholdId, selectedRoutineId, selectedOccurrenceId, localTasks])

  const onNodeDragStart = useCallback(() => {
    insertHoverEdgeIdRef.current = null
    setInsertHoverEdgeId(null)
  }, [])

  const onNodeDrag = useCallback(
    (event: ReactMouseEvent, node: Node) => {
      if (node.type !== "taskNode" || !reactFlowRef.current) {
        if (insertHoverEdgeIdRef.current !== null) {
          insertHoverEdgeIdRef.current = null
          setInsertHoverEdgeId(null)
        }
        return
      }
      const next = findInsertHoverEdgeId(
        reactFlowRef.current,
        flowEdges,
        node.id,
        event.clientX,
        event.clientY,
        INSERT_EDGE_HIT_MAX,
      )
      if (next !== insertHoverEdgeIdRef.current) {
        insertHoverEdgeIdRef.current = next
        setInsertHoverEdgeId(next)
      }
    },
    [flowEdges],
  )

  const onConnect = async (connection: Connection) => {
    if (!connection.source || !connection.target) return
    setFlowEdges((eds) =>
      addEdge({ ...connection, markerEnd: { type: MarkerType.ArrowClosed } }, eds),
    )
    setLocalDeps((prev) => [
      ...prev,
      { source_task_id: connection.source!, target_task_id: connection.target! },
    ])
    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createDependency",
        householdId: selectedHouseholdId,
        sourceTaskId: connection.source,
        targetTaskId: connection.target,
        occurrenceId: selectedOccurrenceId,
      }),
    })
    await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
  }

  const onNodeDragStop = async (_: unknown, node: Node, draggedNodes: Node[]) => {
    if (node.type === "dayDivider") {
      const data = node.data as DayDividerData
      if (data.locked) return
      setFlowNodes((nds) => {
        const next = nds.map((n) => {
          if (n.id !== node.id || n.type !== "dayDivider") return n
          const current = n.position
          const currData = n.data as DayDividerData
          if (data.orientation === "horizontal") {
            return {
              ...n,
              position: { x: taskClusterCenter.x, y: node.position.y },
              data: {
                ...currData,
                labelOffsetX:
                  (currData.labelOffsetX ?? 0) + (node.position.x - taskClusterCenter.x),
              },
            }
          }
          return {
            ...n,
            position: { x: node.position.x, y: taskClusterCenter.y },
            data: {
              ...currData,
              labelOffsetY:
                (currData.labelOffsetY ?? 0) + (node.position.y - taskClusterCenter.y),
            },
          }
        })
        saveGuideNodes(
          guideStorageKeyMemo,
          next.filter((m) => m.type === "dayDivider") as Node<DayDividerData>[],
        )
        return next
      })
      return
    }

    const insertEdgeId = insertHoverEdgeIdRef.current
    insertHoverEdgeIdRef.current = null
    setInsertHoverEdgeId(null)

    const rf = reactFlowRef.current
    const edgeForInsert =
      node.type === "taskNode" && insertEdgeId && rf
        ? (rf.getEdges().find((e) => e.id === insertEdgeId) ?? null)
        : null

    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "updateTaskPosition",
        householdId: selectedHouseholdId,
        taskId: node.id,
        x: node.position.x,
        y: node.position.y,
      }),
    })
    setLocalTasks((prev) =>
      prev.map((task) =>
        task.id === node.id ? { ...task, position_x: node.position.x, position_y: node.position.y } : task,
      ),
    )

    if (edgeForInsert && node.type === "taskNode" && draggedNodes.length === 1) {
      if (node.id !== edgeForInsert.source && node.id !== edgeForInsert.target) {
        const res = await fetch("/api/leader/flow", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "insertIntoDependency",
            householdId: selectedHouseholdId,
            sourceTaskId: edgeForInsert.source,
            targetTaskId: edgeForInsert.target,
            insertTaskId: node.id,
            occurrenceId: selectedOccurrenceId,
          }),
        })
        if (res.ok) {
          await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
        }
      }
    }
  }

  const deleteTask = async (task: Task) => {
    await flushTaskSettingsIfDirtyRef.current()
    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deleteTask",
        householdId: selectedHouseholdId,
        taskId: task.id,
        occurrenceId: selectedOccurrenceId,
      }),
    })
    setActiveTask(null)
    await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
  }

  const deleteTaskById = async (taskId: string, occurrenceId?: string | null) => {
    await flushTaskSettingsIfDirtyRef.current()
    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deleteTask",
        householdId: selectedHouseholdId,
        taskId,
        occurrenceId: occurrenceId ?? null,
      }),
    })
    setActiveTask(null)
    await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
  }

  const deleteDependency = async (sourceTaskId: string, targetTaskId: string, edgeId: string) => {
    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deleteDependency",
        householdId: selectedHouseholdId,
        sourceTaskId,
        targetTaskId,
        occurrenceId: selectedOccurrenceId,
      }),
    })
    setFlowEdges((prev) => prev.filter((edge) => edge.id !== edgeId))
    setLocalDeps((prev) =>
      prev.filter(
        (dep) => !(dep.source_task_id === sourceTaskId && dep.target_task_id === targetTaskId),
      ),
    )
    setEdgeMenu(null)
    await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
  }

  const deleteOccurrence = async (occurrenceId: string, routineId?: string) => {
    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deleteOccurrence",
        householdId: selectedHouseholdId,
        occurrenceId,
      }),
    })
    setOccurrenceDeleteConfirm(null)
    setOccurrenceMenu(null)
    const nextOccurrenceId = selectedOccurrenceId === occurrenceId ? null : selectedOccurrenceId
    if (selectedOccurrenceId === occurrenceId) {
      startTransition(() => syncRoute(selectedHouseholdId, routineId ?? null, null))
    }
    await reloadFlow(selectedHouseholdId, routineId ?? null, nextOccurrenceId)
  }

  const fetchOccurrenceTaskList = async (occurrenceId: string) => {
    if (occurrenceTaskLists[occurrenceId]) return
    setOccurrenceTaskListsLoading((prev) => ({ ...prev, [occurrenceId]: true }))
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "listOccurrenceTasks",
        householdId: selectedHouseholdId,
        occurrenceId,
      }),
    })
    const json = await response.json()
    const rawTasks = ((json.tasks ?? []) as OccurrenceTaskListItem[]).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      assignee_ids: task.assignee_ids ?? [],
      is_reward: task.is_reward,
    }))
    const orderedTasks = orderOccurrenceTasksForSidebar(
      rawTasks as OccurrenceTaskListItem[],
      (json.dependencies ?? []) as Array<{ source_task_id: string; target_task_id: string }>,
    )
    setOccurrenceTaskLists((prev) => ({
      ...prev,
      [occurrenceId]: orderedTasks,
    }))
    setOccurrenceTaskListsLoading((prev) => ({ ...prev, [occurrenceId]: false }))
  }

  const focusOccurrenceTask = async (
    routineId: string | null,
    occurrenceId: string,
    taskId: string,
  ) => {
    if (selectedOccurrenceId !== occurrenceId || selectedRoutineId !== routineId) {
      syncRoute(selectedHouseholdId, routineId ?? null, occurrenceId)
      await reloadFlow(selectedHouseholdId, routineId ?? null, occurrenceId)
    }
    setSelectedTaskId(taskId)
    setFlowNodes((prev) =>
      prev.map((node) => {
        if (node.type === "dayDivider") return node
        return {
          ...node,
          data: {
            ...node.data,
            highlighted: node.id === taskId,
          },
        }
      }),
    )
    centerTaskInViewport(taskId)
    const fullTask = localTasks.find((t) => t.id === taskId) ?? null
    void openTaskSettings(fullTask)
  }

  const toggleOccurrenceTaskFromSidebar = async (
    routineId: string | null,
    occurrenceId: string,
    taskId: string,
    currentStatus: "locked" | "unlocked" | "completed",
  ) => {
    if (currentStatus === "locked") return
    const completed = currentStatus !== "completed"
    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "setOccurrenceTaskCompleted",
        householdId: selectedHouseholdId,
        occurrenceId,
        taskId,
        completed,
      }),
    })

    // Keep the currently visible flow + sidebar statuses in sync.
    await reloadFlow(
      selectedHouseholdId,
      selectedRoutineId ?? routineId ?? null,
      selectedOccurrenceId ?? occurrenceId,
    )
  }

  const createHousehold = async () => {
    const name = window.prompt("Household name")
    if (!name?.trim()) return
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createHousehold",
        name,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
      }),
    })
    const json = await response.json()
    if (json.household?.id) {
      startTransition(() => syncRoute(json.household.id))
    }
  }

  const createRoutine = async () => {
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createRoutine",
        householdId: selectedHouseholdId,
        name: "New routine",
        type: "recurring",
      }),
    })
    const json = await response.json()
    if (response.ok && json?.routine?.id) {
      const nextId = String(json.routine.id)
      setEditingRoutineId(nextId)
      setEditingRoutineValue(String(json.routine.name ?? "New routine"))
      startTransition(() => syncRoute(selectedHouseholdId, nextId, null))
    }
    await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
  }

  const applyRoutineUpdate = useCallback((routine: Routine | null | undefined) => {
    if (!routine?.id) return
    setLocalRoutines((prev) => prev.map((row) => (row.id === routine.id ? { ...row, ...routine } : row)))
  }, [])

  const createOccurrence = async (routineId: string) => {
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createOccurrence",
        householdId: selectedHouseholdId,
        routineId,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
      }),
    })
    const responseText = await response.text()
    let json: { occurrence?: { id?: string }; error?: string } = {}
    if (responseText) {
      try {
        json = JSON.parse(responseText) as { occurrence?: { id?: string }; error?: string }
      } catch {
        json = {}
      }
    }
    if (!response.ok) {
      window.alert(String(json?.error ?? "Failed to create occurrence"))
      return
    }
    if (response.ok && json?.occurrence?.id) {
      cloneTemplateGuidesToOccurrence(selectedHouseholdId, routineId, String(json.occurrence.id))
    }
    await reloadFlow(selectedHouseholdId, routineId, null)
  }

  const addRecurrenceRule = async (routineId: string) => {
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "addRecurrenceRule",
        householdId: selectedHouseholdId,
        routineId,
      }),
    })
    const json = await response.json()
    if (!response.ok) {
      window.alert(String(json?.error ?? "Failed to add recurrence rule"))
      return
    }
    applyRoutineUpdate(json.routine as Routine)
    const rules = parseRoutineRecurrenceRules(json?.routine?.recurrence_rule ?? null)
    const created = rules[rules.length - 1]
    if (created?.id) {
      setExpandedRecurrenceRuleIds((prev) => ({ ...prev, [created.id]: true }))
    }
    setRoutinePlusMenu(null)
  }

  const updateRecurrenceRule = async (routineId: string, rule: RecurrenceRule) => {
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "updateRecurrenceRule",
        householdId: selectedHouseholdId,
        routineId,
        recurrenceRuleId: rule.id,
        rule,
      }),
    })
    const json = await response.json()
    if (!response.ok) {
      window.alert(String(json?.error ?? "Failed to save recurrence rule"))
      return
    }
    applyRoutineUpdate(json.routine as Routine)
  }

  const updateRoutineRecurrenceSettings = async (
    routineId: string,
    completeOlderOccurrencesOnNew: boolean,
  ) => {
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "updateRoutineRecurrenceSettings",
        householdId: selectedHouseholdId,
        routineId,
        completeOlderOccurrencesOnNew,
      }),
    })
    const json = await response.json()
    if (!response.ok) {
      window.alert(String(json?.error ?? "Failed to update recurrence settings"))
      return
    }
    applyRoutineUpdate(json.routine as Routine)
  }

  const deleteRecurrenceRule = async (routineId: string, recurrenceRuleId: string) => {
    const confirmed = window.confirm("Delete this recurrence rule?")
    if (!confirmed) return
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deleteRecurrenceRule",
        householdId: selectedHouseholdId,
        routineId,
        recurrenceRuleId,
      }),
    })
    const json = await response.json()
    if (!response.ok) {
      window.alert(String(json?.error ?? "Failed to delete recurrence rule"))
      return
    }
    applyRoutineUpdate(json.routine as Routine)
    setExpandedRecurrenceRuleIds((prev) => {
      if (!prev[recurrenceRuleId]) return prev
      const next = { ...prev }
      delete next[recurrenceRuleId]
      return next
    })
  }

  const updateRecurrenceRuleField = (rule: RecurrenceRule, patch: Partial<RecurrenceRule>) => {
    if (!selectedRoutineId || selectedOccurrenceId) return
    const nextRule = { ...rule, ...patch }
    setLocalRoutines((prev) =>
      prev.map((routine) => {
        if (routine.id !== selectedRoutineId) return routine
        const rules = parseRoutineRecurrenceRules(routine.recurrence_rule)
        const nextRules = rules.map((existing) => (existing.id === rule.id ? { ...existing, ...nextRule } : existing))
        return {
          ...routine,
          recurrence_rule: serializeRoutineRecurrenceRules(nextRules),
        }
      }),
    )
    const timerKey = `${selectedRoutineId}:${rule.id}`
    const existingTimer = recurrenceSaveTimersRef.current[timerKey]
    if (existingTimer) clearTimeout(existingTimer)
    recurrenceSaveTimersRef.current[timerKey] = setTimeout(() => {
      void updateRecurrenceRule(selectedRoutineId, nextRule)
      recurrenceSaveTimersRef.current[timerKey] = null
    }, 300)
  }

  const createTaskBoard = async () => {
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createTaskBoard",
        householdId: selectedHouseholdId,
        title: "New task board",
      }),
    })
    const json = await response.json()
    if (response.ok && json?.occurrence?.id) {
      const nextOccurrenceId = String(json.occurrence.id)
      setEditingBoardId(nextOccurrenceId)
      setEditingBoardValue(String(json.occurrence.title ?? "New task board"))
      startTransition(() => syncRoute(selectedHouseholdId, null, nextOccurrenceId))
      await reloadFlow(selectedHouseholdId, null, nextOccurrenceId)
    }
  }

  const createTask = async () => {
    if (!selectedRoutineId && !selectedOccurrenceId) {
      window.alert("Select a routine or task board first.")
      return
    }
    const selectedBoardRoutineId =
      selectedOccurrenceId
        ? (localOccurrences.find((occ) => occ.id === selectedOccurrenceId)?.routine_id ?? null)
        : selectedRoutineId
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createTask",
        householdId: selectedHouseholdId,
        routineId: selectedBoardRoutineId,
        occurrenceId: selectedOccurrenceId,
        title: "New task",
        isReward: false,
      }),
    })
    if (response.ok) {
      await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
    }
  }

  const createInvite = async () => {
    const maxUsesInput = window.prompt("Max invite uses", "10")
    if (!maxUsesInput) return
    const expiresInDaysInput = window.prompt("Expires in days", "30")
    if (!expiresInDaysInput) return

    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createInvite",
        householdId: selectedHouseholdId,
        maxUses: Number(maxUsesInput),
        expiresInDays: Number(expiresInDaysInput),
      }),
    })
    await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
  }

  const copyInviteLink = async (code: string) => {
    const url = `${window.location.origin}/join/${code}`
    await navigator.clipboard.writeText(url)
  }

  const deactivateInvite = async (inviteId: string) => {
    const confirmed = window.confirm(
      "Delete this invite link? Existing household members stay in the household, but this link will no longer work.",
    )
    if (!confirmed) return

    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "deactivateInvite",
        householdId: selectedHouseholdId,
        inviteId,
      }),
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null
      window.alert(payload?.error ?? "Unable to delete invite link.")
      return
    }
    setLocalInvites((prev) => prev.filter((invite) => invite.id !== inviteId))
  }

  const updateMemberTokenColor = async (memberUserId: string, tokenColor: string) => {
    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "updateMemberTokenColor",
        householdId: selectedHouseholdId,
        memberUserId,
        tokenColor,
      }),
    })
    setLocalMembers((prev) =>
      prev.map((member) =>
        member.id === memberUserId ? { ...member, token_color: tokenColor } : member,
      ),
    )
  }

  const updateMemberRole = async (memberUserId: string, role: "member" | "supervisor") => {
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "updateMemberRole",
        householdId: selectedHouseholdId,
        memberUserId,
        role,
      }),
    })
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    if (!response.ok) {
      window.alert(payload?.error ?? "Unable to update member role.")
      return
    }
    setLocalMembers((prev) =>
      prev.map((member) =>
        member.id === memberUserId ? { ...member, role } : member,
      ),
    )
  }

  const renameHouseholdMember = async (memberUserId: string, name: string) => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      window.alert("Member name is required.")
      return
    }
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "renameHouseholdMember",
        householdId: selectedHouseholdId,
        memberUserId,
        name: trimmedName,
      }),
    })
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    if (!response.ok) {
      window.alert(payload?.error ?? "Unable to rename household member.")
      return
    }
    setLocalMembers((prev) =>
      prev.map((member) => (member.id === memberUserId ? { ...member, name: trimmedName } : member)),
    )
  }

  const removeHouseholdMember = async (memberUserId: string, memberName: string) => {
    const confirmed = window.confirm(`Remove ${memberName} from this household?`)
    if (!confirmed) return
    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "removeHouseholdMember",
        householdId: selectedHouseholdId,
        memberUserId,
      }),
    })
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    if (!response.ok) {
      window.alert(payload?.error ?? "Unable to remove household member.")
      return
    }
    setLocalMembers((prev) => prev.filter((member) => member.id !== memberUserId))
    await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
  }

  const createHouseholdMember = async () => {
    const name = window.prompt("Member name")
    if (!name?.trim()) return
    const roleInput = window.prompt("Profile type: member or supervisor", "member")
    const role = String(roleInput ?? "").trim().toLowerCase() === "supervisor" ? "supervisor" : "member"
    const colorInput = window.prompt("Token color (optional)", "sky")
    const tokenColor = String(colorInput ?? "").trim() || null

    const response = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "createHouseholdMember",
        householdId: selectedHouseholdId,
        name: name.trim(),
        role,
        tokenColor,
      }),
    })
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; member?: Member }
      | null
    if (!response.ok || !payload?.member) {
      window.alert(payload?.error ?? "Unable to add household member.")
      return
    }
    setLocalMembers((prev) => [...prev, payload.member as Member])
  }

  const saveTaskSettings = async (formData: FormData, taskForSave: Task) => {
    const task = taskForSave
    const isOccurrenceTask = Boolean(task.routine_occurrence_id)
    const unlockDateInput = normalizeDateInput(String(formData.get("unlockDate") ?? ""))
    const unlockModeRaw = String(formData.get("unlockMode") ?? "none")
    const unlockMode = isOccurrenceTask ? (unlockDateInput ? "fixed" : "none") : unlockModeRaw
    const unlockTime = String(formData.get("unlockTime") ?? "").trim() || null
    const unlockRule =
      unlockMode === "none"
        ? null
        : unlockMode === "fixed"
          ? {
              kind: "fixed",
              date: unlockDateInput,
              time: unlockTime,
            }
          : unlockMode === "after_generation_days"
            ? {
                kind: "after_generation_days",
                days: Number(formData.get("unlockAfterDays") ?? 0),
                time: unlockTime,
              }
            : unlockMode === "weekday_after_generation"
              ? {
                  kind: "weekday_after_generation",
                  weekday: Number(formData.get("unlockWeekday") ?? 5),
                  nth: Number(formData.get("unlockWeekdayNth") ?? 1),
                  time: unlockTime,
                }
              : {
                  kind: "month_day_after_generation",
                  dayOfMonth: Number(formData.get("unlockMonthDay") ?? 1),
                  time: unlockTime,
                }
    const unlockAtOverride =
      unlockMode === "fixed" && unlockDateInput
        ? new Date(`${unlockDateInput}T${unlockTime ?? "00:00"}:00`).toISOString()
        : null
    const expiryMode = String(formData.get("expiryMode") ?? "none")
    const expiryTime = String(formData.get("expiryTime") ?? "").trim() || null
    const expiryDateInput = normalizeDateInput(String(formData.get("expiryDate") ?? ""))
    const expiryRule =
      expiryMode === "none"
        ? null
        : expiryMode === "fixed"
          ? {
              kind: "fixed",
              date: expiryDateInput,
              time: expiryTime,
            }
          : expiryMode === "after_creation"
            ? {
                kind: "after_creation",
                amount: Number(formData.get("expiryOffsetAmount") ?? 0),
                unit: String(formData.get("expiryOffsetUnit") ?? "minutes"),
              }
            : expiryMode === "after_unlock"
              ? {
                  kind: "after_unlock",
                  amount: Number(formData.get("expiryOffsetAmount") ?? 0),
                  unit: String(formData.get("expiryOffsetUnit") ?? "minutes"),
                }
              : expiryMode === "weekday_after_unlock"
                ? {
                    kind: "weekday_after_unlock",
                    weekday: Number(formData.get("expiryWeekday") ?? 5),
                    nth: Number(formData.get("expiryWeekdayNth") ?? 1),
                    time: expiryTime,
                  }
                : expiryMode === "month_day_after_unlock"
                  ? {
                      kind: "month_day_after_unlock",
                      dayOfMonth: Number(formData.get("expiryMonthDay") ?? 1),
                      time: expiryTime,
                    }
              : expiryMode === "after_generation_days"
                ? {
                    kind: "after_generation_days",
                    days: Number(formData.get("expiryAfterDays") ?? 0),
                    time: expiryTime,
                  }
                : expiryMode === "weekday_after_generation"
                  ? {
                      kind: "weekday_after_generation",
                      weekday: Number(formData.get("expiryWeekday") ?? 5),
                      nth: Number(formData.get("expiryWeekdayNth") ?? 1),
                      time: expiryTime,
                    }
                  : {
                      kind: "month_day_after_generation",
                      dayOfMonth: Number(formData.get("expiryMonthDay") ?? 1),
                      time: expiryTime,
                    }
    const expiryAtOverride =
      expiryMode === "fixed" && expiryDateInput
        ? new Date(`${expiryDateInput}T${expiryTime ?? "00:00"}:00`).toISOString()
        : null
    const payload = {
      action: "updateTask",
      householdId: selectedHouseholdId,
      taskId: task.id,
      occurrenceId: task.routine_occurrence_id ?? selectedOccurrenceId,
      title: String(formData.get("title") ?? task.title),
      notes: String(formData.get("notes") ?? ""),
      assigneeIds: formData.getAll("assigneeIds").map(String),
      isReward: String(formData.get("type") ?? "task") === "reward",
      unlockRule,
      unlockAtOverride,
      unlockCombiner: String(formData.get("unlockCombiner") ?? "and"),
      expiryRule,
      expiryAtOverride,
    }
    const saveResponse = await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    if (!saveResponse.ok) {
      const errorPayload = await saveResponse.json().catch(() => ({}))
      throw new Error(String(errorPayload?.error ?? "Failed to save task settings"))
    }
    const saveJson = await saveResponse.json().catch(() => ({}))
    if (!saveJson?.task) {
      throw new Error("Task settings were not persisted by the backend")
    }
    await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
    return saveJson.task as Task
  }

  const runTaskSettingsAutosave = async (formData: FormData, taskForSave?: Task | null) => {
    const task = taskForSave ?? activeTaskForSettingsRef.current
    if (!task) return
    const requestId = ++taskSettingsSaveRequestIdRef.current
    setTaskSettingsSaveState("saving")
    setTaskSettingsSaveError(null)
    try {
      await saveTaskSettings(formData, task)
      if (requestId !== taskSettingsSaveRequestIdRef.current) return
      setTaskSettingsSaveState("saved")
    } catch (error) {
      if (requestId !== taskSettingsSaveRequestIdRef.current) return
      setTaskSettingsSaveState("error")
      setTaskSettingsSaveError(error instanceof Error ? error.message : "Failed to save task settings")
    }
  }

  const flushTaskSettingsIfDirty = async () => {
    if (taskSettingsAutosaveTimerRef.current) {
      clearTimeout(taskSettingsAutosaveTimerRef.current)
      taskSettingsAutosaveTimerRef.current = null
    }
    const form = taskSettingsFormRef.current
    const task = activeTaskForSettingsRef.current
    if (!form || !task) return
    await runTaskSettingsAutosave(new FormData(form), task)
  }
  flushTaskSettingsIfDirtyRef.current = flushTaskSettingsIfDirty

  const scheduleTaskSettingsAutosave = (immediate = false) => {
    if (!activeTaskForSettingsRef.current) return
    if (!taskSettingsFormRef.current) return
    if (taskSettingsAutosaveTimerRef.current) {
      clearTimeout(taskSettingsAutosaveTimerRef.current)
      taskSettingsAutosaveTimerRef.current = null
    }
    const save = () => {
      const form = taskSettingsFormRef.current
      const task = activeTaskForSettingsRef.current
      if (!form || !task) return
      void runTaskSettingsAutosave(new FormData(form), task)
    }
    if (immediate) {
      save()
      return
    }
    taskSettingsAutosaveTimerRef.current = setTimeout(save, 280)
  }

  useEffect(() => {
    if (!activeTask) {
      if (taskSettingsAutosaveTimerRef.current) {
        clearTimeout(taskSettingsAutosaveTimerRef.current)
        taskSettingsAutosaveTimerRef.current = null
      }
      setTaskSettingsSaveState("idle")
      setTaskSettingsSaveError(null)
      return
    }
    setTaskSettingsSaveState("idle")
    setTaskSettingsSaveError(null)
  }, [activeTask])

  useEffect(() => {
    return () => {
      if (taskSettingsAutosaveTimerRef.current) {
        clearTimeout(taskSettingsAutosaveTimerRef.current)
      }
    }
  }, [])

  const openTaskSettings = async (task: Task | null) => {
    if (!task) return
    if (!activeTask || activeTask.id !== task.id) {
      await flushTaskSettingsIfDirty()
    }
    const rule = task.unlock_rule as { kind?: string } | null
    const expiryRule = task.expiry_rule as { kind?: string } | null
    const isOccurrenceTask = Boolean(task.routine_occurrence_id)
    setUnlockModeSelection(isOccurrenceTask ? "fixed" : String(rule?.kind ?? "none"))
    const expiryKind = String(expiryRule?.kind ?? "none")
    const normalizedTemplateExpiryKind =
      !isOccurrenceTask
        ? expiryKind === "fixed"
          ? "none"
          : expiryKind === "after_generation_days"
            ? "after_creation"
            : expiryKind
        : expiryKind
    const shouldCoerceOccurrenceExpiryToFixed =
      Boolean(task.routine_occurrence_id) &&
      (expiryKind === "after_creation" ||
        (expiryKind === "after_unlock" && Boolean(task.expires_at)) ||
        (expiryKind === "weekday_after_unlock" && Boolean(task.expires_at)) ||
        (expiryKind === "month_day_after_unlock" && Boolean(task.expires_at)) ||
        expiryKind === "after_generation_days" ||
        expiryKind === "weekday_after_generation" ||
        expiryKind === "month_day_after_generation")
    setExpiryModeSelection(
      shouldCoerceOccurrenceExpiryToFixed ? "fixed" : normalizedTemplateExpiryKind,
    )
    setActiveTask(task)
  }

  const commitRoutineRename = async (routineId: string) => {
    const name = editingRoutineValue.trim()
    if (!name) {
      setEditingRoutineId(null)
      return
    }
    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "renameRoutine",
        householdId: selectedHouseholdId,
        routineId,
        name,
      }),
    })
    setEditingRoutineId(null)
    await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
  }

  const commitBoardRename = async (occurrenceId: string) => {
    const title = editingBoardValue.trim()
    if (!title) {
      setEditingBoardId(null)
      return
    }
    await fetch("/api/leader/flow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "renameTaskBoard",
        householdId: selectedHouseholdId,
        occurrenceId,
        title,
      }),
    })
    setEditingBoardId(null)
    await reloadFlow(selectedHouseholdId, selectedRoutineId, selectedOccurrenceId)
  }

  const taskBoardTitle = (board: RoutineOccurrence) => {
    if (board.kind === "manual") return board.title?.trim() || `Board ${formatDateStable(board.scheduled_for)}`
    if (board.routine_id) {
      const name = routineNameById.get(board.routine_id)
      if (name) return `${name} - ${formatDateStable(board.scheduled_for)}`
    }
    return `Occurrence ${formatDateStable(board.scheduled_for)}`
  }

  const guideMenuLocked = guideLineMenu
    ? Boolean(
        (flowNodes.find((node) => node.id === guideLineMenu.nodeId && node.type === "dayDivider")?.data as
          | DayDividerData
          | undefined)?.locked,
      )
    : false

  return (
    <main className="relative flex h-full min-h-0 w-full overflow-hidden rounded-xl border border-border/80 bg-muted/25 shadow-sm ring-1 ring-black/[0.03] dark:ring-white/[0.06]">
      <aside className="z-10 flex h-full w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="border-b border-sidebar-border px-3 pb-3 pt-3">
          <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Household
          </label>
          <select
            className="mt-1.5 w-full cursor-pointer rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            value={selectedHouseholdId}
            onChange={(event) => {
              const value = event.target.value
              if (value === "__create__") {
                void createHousehold()
                return
              }
              startTransition(() => syncRoute(value, null))
            }}
          >
            {households.map((household) => (
              <option key={household.id} value={household.id}>
                {household.name}
              </option>
            ))}
            <option value="__create__">+ Create new household</option>
          </select>
        </div>

        <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-2.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Routines</h2>
          <Button type="button" variant="outline" size="xs" className="h-7 gap-1 font-medium" onClick={createRoutine}>
            <Plus className="size-3.5" aria-hidden />
            Add
          </Button>
        </div>
        <div className="flex-1 space-y-3 overflow-auto px-2 py-3">
          {localRoutines.map((routine) => (
            <div
              key={routine.id}
              className="rounded-xl border border-border/60 bg-card/80 p-1 shadow-sm backdrop-blur-sm transition-colors hover:border-border"
            >
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={() =>
                    setExpandedRoutineIds((prev) => ({
                      ...prev,
                      [routine.id]: !prev[routine.id],
                    }))
                  }
                  title={expandedRoutineIds[routine.id] ? "Collapse routine" : "Expand routine"}
                >
                  {expandedRoutineIds[routine.id] ? (
                    <ChevronDown className="size-4" aria-hidden />
                  ) : (
                    <ChevronRight className="size-4" aria-hidden />
                  )}
                </button>
                {editingRoutineId === routine.id ? (
                  <input
                    autoFocus
                    value={editingRoutineValue}
                    onChange={(event) => setEditingRoutineValue(event.target.value)}
                    onBlur={() => {
                      void commitRoutineRename(routine.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        void commitRoutineRename(routine.id)
                      } else if (event.key === "Escape") {
                        setEditingRoutineId(null)
                      }
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-ring/60 bg-background px-2 py-1.5 text-sm font-medium outline-none ring-2 ring-ring/30"
                  />
                ) : (
                  <button
                    type="button"
                    onDoubleClick={() => {
                      setEditingRoutineId(routine.id)
                      setEditingRoutineValue(routine.name)
                    }}
                    onClick={() => syncRoute(selectedHouseholdId, routine.id, null)}
                    className={cn(
                      "min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left text-sm font-medium transition-colors",
                      selectedRoutineId === routine.id && !selectedOccurrenceId
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-foreground hover:bg-muted/90",
                    )}
                  >
                    <span className="block truncate">{routine.name}</span>
                  </button>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  className="shrink-0"
                  data-routine-plus-trigger
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    setRoutinePlusMenu({
                      routineId: routine.id,
                      x: rect.left,
                      y: rect.bottom + 6,
                    })
                  }}
                  title="Add occurrence"
                  aria-label="Add occurrence"
                >
                  <Plus className="size-4" aria-hidden />
                </Button>
              </div>
              {expandedRoutineIds[routine.id] ? (
                <div className="ml-1 mt-2 space-y-1 border-t border-border/50 pt-2">
                  {(expandedTemplateSectionIds[routine.id] ?? true)
                    ? getOrderedTasksForRoutine(routine.id).map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        className={cn(
                          "block w-full rounded-lg px-2 py-1.5 text-left text-xs",
                          sidebarLeafTaskClass(
                            Boolean(task.is_reward),
                            selectedTaskId === task.id,
                            localTasks.find((t) => t.id === task.id)?.status === "completed",
                          ),
                        )}
                        onClick={() => {
                          syncRoute(selectedHouseholdId, routine.id, null)
                          setSelectedTaskId(task.id)
                          setFlowNodes((prev) =>
                            prev.map((node) => {
                              if (node.type === "dayDivider") return node
                              return {
                                ...node,
                                data: {
                                  ...node.data,
                                  highlighted: node.id === task.id,
                                },
                              }
                            }),
                          )
                          centerTaskInViewport(task.id)
                          const fullTask = localTasks.find((t) => t.id === task.id) ?? null
                          void openTaskSettings(fullTask)
                          setTaskMenu(null)
                          setOccurrenceMenu(null)
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setTaskMenu({
                            taskId: task.id,
                            taskIds: [task.id],
                            routineId: routine.id,
                            occurrenceId: null,
                            x: event.clientX,
                            y: event.clientY,
                          })
                          setOccurrenceMenu(null)
                          setEdgeMenu(null)
                          setGuideLineMenu(null)
                        }}
                      >
                        <span className="flex w-full min-w-0 items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate">{task.title}</span>
                          {renderSidebarAssigneeTokens(
                            localTemplateTaskAssignees
                              .filter((assignment) => assignment.task_id === task.id)
                              .map((assignment) => assignment.user_id),
                          )}
                        </span>
                      </button>
                    ))
                    : null}
                </div>
              ) : null}
            </div>
          ))}

          <div className="rounded-xl border border-border/60 bg-card/80 p-1 shadow-sm backdrop-blur-sm transition-colors hover:border-border">
            <div className="flex items-center justify-between px-1 py-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tasks</h3>
              <Button type="button" variant="outline" size="icon-xs" onClick={createTaskBoard} title="Add task board">
                <Plus className="size-3.5" aria-hidden />
              </Button>
            </div>
            <div className="mt-1 space-y-1 border-t border-border/50 pt-2">
              {taskBoards.map((board) => (
                <div key={board.id}>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      title={
                        expandedOccurrenceTaskSectionIds[board.id]
                          ? "Collapse board tasks"
                          : "Expand board tasks"
                      }
                      onClick={() => {
                        const next = !(expandedOccurrenceTaskSectionIds[board.id] ?? false)
                        setExpandedOccurrenceTaskSectionIds((prev) => ({ ...prev, [board.id]: next }))
                        if (next) {
                          void fetchOccurrenceTaskList(board.id)
                        }
                      }}
                    >
                      {(expandedOccurrenceTaskSectionIds[board.id] ?? false) ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )}
                    </button>
                    {editingBoardId === board.id ? (
                      <input
                        autoFocus
                        value={editingBoardValue}
                        onChange={(event) => setEditingBoardValue(event.target.value)}
                        onBlur={() => {
                          void commitBoardRename(board.id)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void commitBoardRename(board.id)
                          } else if (event.key === "Escape") {
                            setEditingBoardId(null)
                          }
                        }}
                        className="min-w-0 flex-1 rounded-lg border border-ring/60 bg-background px-2 py-1.5 text-[11px] font-medium outline-none ring-2 ring-ring/30"
                      />
                    ) : (
                      <button
                        type="button"
                        className={cn(
                          "min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors",
                          selectedOccurrenceId === board.id
                            ? "bg-accent font-medium text-accent-foreground shadow-sm ring-1 ring-border/60"
                            : "text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                        )}
                        onDoubleClick={() => {
                          setEditingBoardId(board.id)
                          setEditingBoardValue(taskBoardTitle(board))
                        }}
                        onClick={() => {
                          syncRoute(selectedHouseholdId, board.routine_id ?? null, board.id)
                          void reloadFlow(selectedHouseholdId, board.routine_id ?? null, board.id)
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setOccurrenceMenu({
                            occurrenceId: board.id,
                            routineId: board.routine_id ?? undefined,
                            x: event.clientX,
                            y: event.clientY,
                          })
                          setTaskMenu(null)
                          setEdgeMenu(null)
                          setGuideLineMenu(null)
                        }}
                      >
                        {taskBoardTitle(board)} - {board.completed_tasks}/{board.total_tasks} completed
                      </button>
                    )}
                  </div>
                  {(expandedOccurrenceTaskSectionIds[board.id] ?? false) ? (
                    <div className="ml-6 mt-1 space-y-1">
                      {(occurrenceTaskListsLoading[board.id] ?? false) ? (
                        <p className="px-2 py-1 text-[11px] text-muted-foreground">Loading tasks...</p>
                      ) : (
                        (occurrenceTaskLists[board.id] ?? [])
                          .filter((task) => !hideCompletedTasks || task.status !== "completed")
                          .map((task) => (
                            <div
                              key={task.id}
                              role="button"
                              tabIndex={0}
                              className={cn(
                                "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs",
                                sidebarLeafTaskClass(
                                  Boolean(task.is_reward),
                                  selectedTaskId === task.id,
                                  task.status === "completed",
                                ),
                              )}
                              onClick={() => {
                                void focusOccurrenceTask(board.routine_id ?? null, board.id, task.id)
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault()
                                  void focusOccurrenceTask(board.routine_id ?? null, board.id, task.id)
                                }
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault()
                                setTaskMenu({
                                  taskId: task.id,
                                  taskIds: [task.id],
                                  routineId: board.routine_id ?? undefined,
                                  occurrenceId: board.id,
                                  x: event.clientX,
                                  y: event.clientY,
                                })
                                setOccurrenceMenu(null)
                                setEdgeMenu(null)
                                setGuideLineMenu(null)
                              }}
                            >
                              <span className="flex w-full min-w-0 items-center justify-between gap-2">
                                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                                {renderSidebarAssigneeTokens(task.assignee_ids ?? [])}
                              </span>
                              <button
                                type="button"
                                disabled={task.status === "locked"}
                                aria-label={
                                  task.status === "completed"
                                    ? "Mark task incomplete"
                                    : task.status === "locked"
                                      ? "Task locked by prerequisites"
                                      : "Mark task complete"
                                }
                                title={
                                  task.status === "completed"
                                    ? "Mark incomplete"
                                    : task.status === "locked"
                                      ? "Locked by prerequisites"
                                      : "Mark complete"
                                }
                                className={`ml-2 inline-flex h-3.5 w-3.5 items-center justify-center rounded border text-[10px] leading-none ${
                                  task.status === "completed"
                                    ? "border-zinc-900 bg-zinc-900 text-white"
                                    : task.status === "locked"
                                      ? "cursor-not-allowed border-zinc-300 bg-zinc-200 text-zinc-400 opacity-60"
                                      : "border-zinc-400 bg-white text-transparent hover:border-zinc-500"
                                }`}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void toggleOccurrenceTaskFromSidebar(
                                    board.routine_id ?? null,
                                    board.id,
                                    task.id,
                                    task.status,
                                  )
                                }}
                              >
                                {task.status === "completed" ? "✓" : ""}
                              </button>
                            </div>
                          ))
                      )}
                      {(occurrenceTaskLists[board.id] ?? []).filter((task) => !hideCompletedTasks || task.status !== "completed").length === 0 &&
                      !(occurrenceTaskListsLoading[board.id] ?? false) ? (
                        <p className="px-2 py-1 text-[11px] text-muted-foreground">No visible tasks in this board.</p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
              {taskBoards.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">No task boards yet.</p>
              ) : null}
            </div>
            <label className="mt-2 flex items-center gap-2 rounded-md px-2 py-1 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={hideCompletedTasks}
                onChange={(event) => setHideCompletedTasks(event.target.checked)}
              />
              Hide completed tasks
            </label>
          </div>
        </div>
      </aside>

      <section
        ref={flowSectionRef}
        className={`relative flex-1 ${guidePlaceMode ? "cursor-crosshair" : ""}`}
        onMouseMove={(event) => {
          if (!guidePlaceMode || !reactFlowRef.current) return
          const p = reactFlowRef.current.screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
          })
          setGuidePreviewFlow(p)
        }}
      >
        {guidePlaceMode && guidePreviewScreen ? (
          <div className="pointer-events-none absolute inset-0 z-20">
            {guidePlaceMode === "horizontal" ? (
              <div
                className="absolute border-t-2 border-dotted border-blue-500/90"
                style={{
                  left: 0,
                  right: 0,
                  top: guidePreviewScreen.y,
                }}
              />
            ) : (
              <div
                className="absolute border-l-2 border-dotted border-blue-500/90"
                style={{
                  top: 0,
                  bottom: 0,
                  left: guidePreviewScreen.x,
                }}
              />
            )}
          </div>
        ) : null}
        {selectedOccurrenceId ? (
          <div className="absolute left-4 top-4 z-20 max-w-md rounded-lg border border-primary/20 bg-primary/8 px-3 py-2.5 text-xs leading-relaxed text-foreground shadow-sm backdrop-blur-sm dark:bg-primary/15">
            <span className="font-medium text-primary">Task board</span>
          </div>
        ) : null}
        {selectedRoutineId && !selectedOccurrenceId ? (
          <div className="pointer-events-none absolute inset-0 z-30">
            {Object.values(expandedRecurrenceRuleIds).some(Boolean) ? (
              <button
                type="button"
                aria-label="Collapse recurrence widgets"
                className="pointer-events-auto absolute inset-0 cursor-default bg-transparent"
                onClick={() => setExpandedRecurrenceRuleIds({})}
              />
            ) : null}
            <div className="absolute left-4 top-4 flex max-h-[70vh] w-[22rem] flex-col gap-2 overflow-auto pr-1">
            {selectedRoutine ? (
              <div
                data-recurrence-widget
                className="pointer-events-auto rounded-xl border border-border/80 bg-card/95 p-3 text-xs shadow-xl ring-1 ring-black/[0.04] backdrop-blur-md dark:ring-white/[0.06]"
              >
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedRoutine.complete_older_occurrences_on_new)}
                    onChange={(event) => {
                      const checked = event.target.checked
                      setLocalRoutines((prev) =>
                        prev.map((routine) =>
                          routine.id === selectedRoutine.id
                            ? { ...routine, complete_older_occurrences_on_new: checked }
                            : routine,
                        ),
                      )
                      void updateRoutineRecurrenceSettings(selectedRoutine.id, checked)
                    }}
                  />
                  <span title="When enabled, creating a new occurrence for this routine marks older routine occurrences as completed.">
                    New occurences complete older occurrences
                  </span>
                </label>
              </div>
            ) : null}
            {selectedRoutineRecurrenceRules.map((rule) => {
              const isExpanded = Boolean(expandedRecurrenceRuleIds[rule.id])
              return (
                <div
                  key={rule.id}
                  data-recurrence-widget
                  className="pointer-events-auto rounded-xl border border-border/80 bg-card/95 p-3 shadow-xl ring-1 ring-black/[0.04] backdrop-blur-md dark:ring-white/[0.06]"
                >
                  <button
                    type="button"
                    className="w-full text-left text-xs font-medium text-foreground"
                    onClick={() =>
                      setExpandedRecurrenceRuleIds((prev) => ({
                        ...prev,
                        [rule.id]: !prev[rule.id],
                      }))
                    }
                  >
                    Recurrence - {recurrenceRuleSummary(rule)}
                  </button>
                  {isExpanded ? (
                    <div className="mt-3 space-y-2 text-xs">
                      <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                        <span>Repeat every</span>
                        <input
                          type="number"
                          min={1}
                          value={rule.interval}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => {
                            const interval = Number(event.target.value) || 1
                            updateRecurrenceRuleField(rule, {
                              interval: Math.max(1, interval),
                              startDate: interval > 1 ? (rule.startDate ?? todayDateInputValue()) : rule.startDate,
                            })
                          }}
                          className="w-full rounded border border-input bg-background px-2 py-1.5"
                        />
                      </div>
                      {rule.interval > 1 ? (
                        <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                          <span>Start date</span>
                          <input
                            type="date"
                            value={rule.startDate ?? todayDateInputValue()}
                            onChange={(event) => updateRecurrenceRuleField(rule, { startDate: event.target.value })}
                            className="w-full rounded border border-input bg-background px-2 py-1.5"
                          />
                        </div>
                      ) : null}
                      <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                        <span>Frequency</span>
                        <select
                          value={rule.frequency}
                          onChange={(event) => {
                            const frequency = event.target.value as RecurrenceRule["frequency"]
                            if (frequency === "daily") {
                              updateRecurrenceRuleField(rule, { frequency })
                              return
                            }
                            if (frequency === "weekly") {
                              updateRecurrenceRuleField(rule, { frequency, weekday: "monday" })
                              return
                            }
                            if (frequency === "monthly") {
                              updateRecurrenceRuleField(rule, {
                                frequency,
                                monthlyMode: "specific_date",
                                dayOfMonth: 1,
                              })
                              return
                            }
                            updateRecurrenceRuleField(rule, {
                              frequency: "yearly",
                              yearlyMode: "specific_date",
                              month: 1,
                              day: 1,
                            })
                          }}
                          className="w-full rounded border border-input bg-background px-2 py-1.5"
                        >
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                          <option value="monthly">Monthly</option>
                          <option value="yearly">Yearly</option>
                        </select>
                      </div>

                      {rule.frequency === "weekly" ? (
                        <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                          <span>On</span>
                          <select
                            value={rule.weekday ?? "monday"}
                            onChange={(event) =>
                              updateRecurrenceRuleField(rule, { weekday: event.target.value as Weekday })
                            }
                            className="w-full rounded border border-input bg-background px-2 py-1.5"
                          >
                            {WEEKDAY_OPTIONS.map((day) => (
                              <option key={day.value} value={day.value}>
                                {day.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : null}

                      {rule.frequency === "monthly" ? (
                        <>
                          <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                            <span>Mode</span>
                            <select
                              value={rule.monthlyMode ?? "specific_date"}
                              onChange={(event) => {
                                const mode = event.target.value as "specific_date" | "nth"
                                if (mode === "specific_date") {
                                  updateRecurrenceRuleField(rule, { monthlyMode: mode, dayOfMonth: 1 })
                                } else {
                                  updateRecurrenceRuleField(rule, { monthlyMode: mode, nth: "1st", weekday: "monday" })
                                }
                              }}
                              className="w-full rounded border border-input bg-background px-2 py-1.5"
                            >
                              <option value="specific_date">Specific date</option>
                              <option value="nth">Nth</option>
                            </select>
                          </div>
                          {(rule.monthlyMode ?? "specific_date") === "specific_date" ? (
                            <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                              <span>Day</span>
                              <input
                                type="number"
                                min={1}
                                max={31}
                                value={rule.dayOfMonth ?? 1}
                                onFocus={(event) => event.currentTarget.select()}
                                onChange={(event) =>
                                  updateRecurrenceRuleField(rule, {
                                    dayOfMonth: Math.max(1, Number(event.target.value) || 1),
                                  })
                                }
                                className="w-full rounded border border-input bg-background px-2 py-1.5"
                              />
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 gap-2">
                              <select
                                value={String(rule.nth ?? "1st")}
                                onChange={(event) => updateRecurrenceRuleField(rule, { nth: event.target.value as MonthlyNth })}
                                className="w-full rounded border border-input bg-background px-2 py-1.5"
                              >
                                {MONTHLY_NTH_OPTIONS.map((nth) => (
                                  <option key={nth} value={nth}>
                                    {nth}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={rule.weekday ?? "monday"}
                                onChange={(event) =>
                                  updateRecurrenceRuleField(rule, { weekday: event.target.value as Weekday })
                                }
                                className="w-full rounded border border-input bg-background px-2 py-1.5"
                              >
                                {WEEKDAY_OPTIONS.map((day) => (
                                  <option key={day.value} value={day.value}>
                                    {day.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </>
                      ) : null}

                      {rule.frequency === "yearly" ? (
                        <>
                          <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                            <span>Mode</span>
                            <select
                              value={rule.yearlyMode ?? "specific_date"}
                              onChange={(event) => {
                                const mode = event.target.value as "specific_date" | "nth"
                                if (mode === "specific_date") {
                                  updateRecurrenceRuleField(rule, { yearlyMode: mode, month: 1, day: 1 })
                                } else {
                                  updateRecurrenceRuleField(rule, { yearlyMode: mode, nth: "1th", weekday: "monday" })
                                }
                              }}
                              className="w-full rounded border border-input bg-background px-2 py-1.5"
                            >
                              <option value="specific_date">Specific date</option>
                              <option value="nth">Nth</option>
                            </select>
                          </div>
                          {(rule.yearlyMode ?? "specific_date") === "specific_date" ? (
                            <div className="grid grid-cols-2 gap-2">
                              <label className="space-y-1">
                                <span className="text-[11px] text-muted-foreground">Day</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={31}
                                  value={rule.day ?? 1}
                                  onFocus={(event) => event.currentTarget.select()}
                                  onChange={(event) =>
                                    updateRecurrenceRuleField(rule, {
                                      day: Math.max(1, Number(event.target.value) || 1),
                                    })
                                  }
                                  className="w-full rounded border border-input bg-background px-2 py-1.5"
                                />
                              </label>
                              <label className="space-y-1">
                                <span className="text-[11px] text-muted-foreground">Month</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={12}
                                  value={rule.month ?? 1}
                                  onFocus={(event) => event.currentTarget.select()}
                                  onChange={(event) =>
                                    updateRecurrenceRuleField(rule, {
                                      month: Math.max(1, Number(event.target.value) || 1),
                                    })
                                  }
                                  className="w-full rounded border border-input bg-background px-2 py-1.5"
                                />
                              </label>
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 gap-2">
                              <select
                                value={String(rule.nth ?? "1th")}
                                onChange={(event) =>
                                  updateRecurrenceRuleField(rule, { nth: event.target.value as RecurrenceRule["nth"] })
                                }
                                className="w-full rounded border border-input bg-background px-2 py-1.5"
                              >
                                {YEARLY_NTH_OPTIONS.map((nth) => (
                                  <option key={nth} value={nth}>
                                    {nth}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={rule.weekday ?? "monday"}
                                onChange={(event) =>
                                  updateRecurrenceRuleField(rule, { weekday: event.target.value as Weekday })
                                }
                                className="w-full rounded border border-input bg-background px-2 py-1.5"
                              >
                                {WEEKDAY_OPTIONS.map((day) => (
                                  <option key={day.value} value={day.value}>
                                    {day.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </>
                      ) : null}

                      <div className="grid grid-cols-[auto_1fr] items-center gap-2">
                        <span>At</span>
                        <input
                          type="time"
                          value={rule.time}
                          onChange={(event) => updateRecurrenceRuleField(rule, { time: event.target.value })}
                          className="w-full rounded border border-input bg-background px-2 py-1.5"
                        />
                      </div>
                      <p className="rounded border border-border/70 bg-muted/20 px-2 py-1.5 text-[11px] text-muted-foreground">
                        {formatRecurrencePreview(nextRecurrenceDate(rule))}
                      </p>
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="xs"
                          variant="destructive"
                          onClick={() => {
                            if (!selectedRoutineId) return
                            void deleteRecurrenceRule(selectedRoutineId, rule.id)
                          }}
                        >
                          Delete rule
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
            </div>
          </div>
        ) : null}
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodesConnectable
          onInit={(instance) => {
            reactFlowRef.current = instance
          }}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeDoubleClick={(_, node) => {
            if (node.type !== "dayDivider") return
            const data = node.data as DayDividerData
            if (data.locked) return
            const cur = (node.data as DayDividerData).label ?? ""
            setEditingGuideId(node.id)
            setEditingGuideValue(cur)
          }}
          onNodeContextMenu={(e, node) => {
            e.preventDefault()
            if (node.type === "dayDivider") {
              setGuideLineMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
              setEdgeMenu(null)
              setTaskMenu(null)
              return
            }
            if (node.type === "taskNode") {
              const ids =
                node.selected && selectedTaskNodeIds.length > 0 ? selectedTaskNodeIds : [node.id]
              setTaskMenu({
                taskId: node.id,
                taskIds: ids,
                occurrenceId: selectedOccurrenceId,
                x: e.clientX,
                y: e.clientY,
              })
              setGuideLineMenu(null)
              setEdgeMenu(null)
            }
          }}
          onNodeClick={(event, node) => {
            if (guidePlaceMode) {
              setGuidePlaceMode(null)
              setGuidePreviewFlow(null)
              setGuidePreviewScreen(null)
            }
            if (node.type === "dayDivider") {
              clearTaskSelection()
              setEdgeMenu(null)
              setGuideLineMenu(null)
              setOccurrenceMenu(null)
              setTaskMenu(null)
              return
            }
            if (event.shiftKey) {
              const wasSelectedBeforeClick = selectedTaskNodeIds.includes(node.id)
              const nextSelectedIds = new Set(selectedTaskNodeIds)
              if (wasSelectedBeforeClick) {
                nextSelectedIds.delete(node.id)
              } else {
                nextSelectedIds.add(node.id)
              }
              void (async () => {
                await flushTaskSettingsIfDirtyRef.current()
                setSelectedTaskId(null)
                setActiveTask(null)
                setFlowNodes((prev) =>
                  prev.map((existingNode) => {
                    if (existingNode.type === "dayDivider") return existingNode
                    return {
                      ...existingNode,
                      selected: nextSelectedIds.has(existingNode.id),
                      data: {
                        ...existingNode.data,
                        highlighted: false,
                      },
                    }
                  }),
                )
                setEdgeMenu(null)
                setTaskMenu(null)
                setOccurrenceMenu(null)
              })()
              return
            }
            if (node.selected && selectedTaskNodeIds.length > 1) {
              void (async () => {
                await flushTaskSettingsIfDirtyRef.current()
                setSelectedTaskId(null)
                setActiveTask(null)
                setFlowNodes((prev) =>
                  prev.map((existingNode) => {
                    if (existingNode.type === "dayDivider") return existingNode
                    return {
                      ...existingNode,
                      selected: selectedTaskNodeIds.includes(existingNode.id),
                      data: {
                        ...existingNode.data,
                        highlighted: false,
                      },
                    }
                  }),
                )
                setEdgeMenu(null)
                setTaskMenu(null)
                setOccurrenceMenu(null)
              })()
              return
            }
            setSelectedTaskId(node.id)
            setFlowNodes((prev) =>
              prev.map((existingNode) => {
                if (existingNode.type === "dayDivider") return existingNode
                return {
                  ...existingNode,
                  data: {
                    ...existingNode.data,
                    highlighted: existingNode.id === node.id,
                  },
                }
              }),
            )
            setEdgeMenu(null)
            setTaskMenu(null)
            setOccurrenceMenu(null)
            const task = localTasks.find((t) => t.id === node.id) ?? null
            void openTaskSettings(task)
          }}
          onEdgeClick={(event, edge) => {
            event.preventDefault()
            void (async () => {
              await flushTaskSettingsIfDirtyRef.current()
              setActiveTask(null)
              setGuideLineMenu(null)
              setTaskMenu(null)
              setOccurrenceMenu(null)
              setEdgeMenu({
                edgeId: edge.id,
                sourceTaskId: edge.source,
                targetTaskId: edge.target,
                x: event.clientX,
                y: event.clientY,
              })
            })()
          }}
          onPaneMouseMove={(e) => {
            if (!guidePlaceMode || !reactFlowRef.current) return
            const p = reactFlowRef.current.screenToFlowPosition({ x: e.clientX, y: e.clientY })
            setGuidePreviewFlow(p)
          }}
          onMouseDown={(evt: ReactMouseEvent) => {
            const target = evt.target as HTMLElement | null
            if (!target?.closest(".react-flow__pane")) return
            if (evt.button !== 0 || evt.shiftKey) return
            setSelectedTaskId(null)
            setFlowNodes((prev) =>
              prev.map((node) => {
                if (node.type !== "taskNode") return node
                return {
                  ...node,
                  selected: false,
                  data: {
                    ...node.data,
                    highlighted: false,
                  },
                }
              }),
            )
          }}
          onPaneClick={(evt) => {
            setEdgeMenu(null)
            setGuideLineMenu(null)
            setOccurrenceMenu(null)
            setTaskMenu(null)
            clearTaskSelection()
            if (guidePlaceMode && reactFlowRef.current) {
              const p = reactFlowRef.current.screenToFlowPosition({
                x: evt.clientX,
                y: evt.clientY,
              })
              const id = `guide-${crypto.randomUUID()}`
              const newNode: Node<DayDividerData> =
                guidePlaceMode === "horizontal"
                  ? {
                      id,
                      type: "dayDivider",
                      position: { x: taskClusterCenter.x, y: p.y },
                      data: { orientation: "horizontal", label: "", labelOffsetX: 0, labelOffsetY: 0 },
                      draggable: true,
                      selectable: true,
                      zIndex: 0,
                    }
                  : {
                      id,
                      type: "dayDivider",
                      position: { x: p.x, y: taskClusterCenter.y },
                      data: { orientation: "vertical", label: "", labelOffsetX: 0, labelOffsetY: 0 },
                      draggable: true,
                      selectable: true,
                      zIndex: 0,
                    }
              setFlowNodes((nds) => {
                const tasks = nds.filter((n) => n.type === "taskNode")
                const guides = nds.filter((n) => n.type === "dayDivider")
                const next = [...guides, newNode, ...tasks]
                saveGuideNodes(
                  guideStorageKeyMemo,
                  next.filter((n) => n.type === "dayDivider") as Node<DayDividerData>[],
                )
                return next
              })
              setGuidePlaceMode(null)
              setGuidePreviewFlow(null)
              setGuidePreviewScreen(null)
            }
          }}
          onPaneContextMenu={(e) => {
            if (!guidePlaceMode) return
            e.preventDefault()
            setGuidePlaceMode(null)
            setGuidePreviewFlow(null)
            setGuidePreviewScreen(null)
            setTaskMenu(null)
            setOccurrenceMenu(null)
          }}
          nodeTypes={nodeTypes}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag={[1]}
          panActivationKeyCode="Shift"
        >
          <Panel position="bottom-right" className="mb-20 mr-2 flex gap-1.5">
              <button
                type="button"
                title="Add horizontal line"
                onClick={() => {
                  setGuidePlaceMode((prev) => (prev === "horizontal" ? null : "horizontal"))
                  if (reactFlowRef.current) {
                    const viewport = reactFlowRef.current.getViewport()
                    setGuidePreviewFlow({
                      x: -viewport.x / viewport.zoom + 200 / viewport.zoom,
                      y: -viewport.y / viewport.zoom + 120 / viewport.zoom,
                    })
                  } else {
                    setGuidePreviewFlow(null)
                  }
                  setEdgeMenu(null)
                  setGuideLineMenu(null)
                }}
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg border border-border/80 bg-card text-foreground shadow-md transition-[box-shadow,background-color] hover:bg-muted/80",
                  guidePlaceMode === "horizontal" && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                )}
              >
                <Minus className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                title="Add vertical line"
                onClick={() => {
                  setGuidePlaceMode((prev) => (prev === "vertical" ? null : "vertical"))
                  if (reactFlowRef.current) {
                    const viewport = reactFlowRef.current.getViewport()
                    setGuidePreviewFlow({
                      x: -viewport.x / viewport.zoom + 200 / viewport.zoom,
                      y: -viewport.y / viewport.zoom + 120 / viewport.zoom,
                    })
                  } else {
                    setGuidePreviewFlow(null)
                  }
                  setEdgeMenu(null)
                  setGuideLineMenu(null)
                }}
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg border border-border/80 bg-card text-foreground shadow-md transition-[box-shadow,background-color] hover:bg-muted/80",
                  guidePlaceMode === "vertical" && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                )}
              >
                <Minus className="size-4 rotate-90" aria-hidden />
              </button>
            </Panel>
          <Background />
          <Controls />
        </ReactFlow>
      </section>

      <Button
        type="button"
        onClick={createTask}
        size="lg"
        className="absolute bottom-6 left-1/2 z-20 h-11 -translate-x-1/2 rounded-full px-7 shadow-lg shadow-primary/25"
        title="Add task/reward"
      >
        <Plus className="size-4" aria-hidden />
        Add task
      </Button>

      <div className="absolute right-4 top-4 z-30">
        <Button
          ref={householdPanelToggleRef}
          type="button"
          variant={isHouseholdPanelOpen ? "secondary" : "outline"}
          size="sm"
          className="shadow-md"
          onClick={() => setIsHouseholdPanelOpen((prev) => !prev)}
        >
          {isHouseholdPanelOpen ? "Hide household panel" : "Household management"}
        </Button>
      </div>

      {isHouseholdPanelOpen ? (
        <aside
          ref={householdPanelRef}
          className="absolute right-4 top-16 z-30 w-[380px] max-h-[calc(100dvh-5.5rem)] overflow-y-auto overflow-x-visible rounded-xl border border-border/80 bg-card/95 p-4 shadow-2xl shadow-black/10 ring-1 ring-black/[0.04] backdrop-blur-md dark:ring-white/[0.06]"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold tracking-tight">Household management</h3>
          </div>

          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-muted-foreground">Joined users ({localMembers.length})</p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0 gap-1"
                onClick={() => {
                  void createHouseholdMember()
                }}
              >
                <Plus className="size-3.5" aria-hidden />
                Add household member
              </Button>
            </div>
            <ul className="max-h-[min(24rem,calc(100dvh-19rem))] space-y-1.5 overflow-y-auto overflow-x-hidden rounded-lg border border-border/60 bg-muted/20 p-2 text-sm">
              {localMembers.map((member) => {
                const normalizedRole = member.role === "leader" ? "manager" : member.role ?? "member"
                const canEditRole = member.id !== selectedHouseholdLeaderId
                const canEditName = !member.is_clerk_linked
                const currentOption =
                  TOKEN_COLOR_OPTIONS.find((o) => o.id === member.token_color) ?? null
                const popoverId = `hm-token-color-${member.id}`
                const anchorName = `--hm-tok-${member.id.replace(/-/g, "")}`
                const anchorStyles = { anchorName } as React.CSSProperties
                const popoverPositionStyles = {
                  margin: 0,
                  padding: 0,
                  border: "none",
                  background: "transparent" as const,
                  positionAnchor: anchorName,
                  top: "anchor(bottom)",
                  left: "anchor(right)",
                  transform: "translateX(-100%)",
                  marginTop: 4,
                } as React.CSSProperties
                return (
                  <li
                    key={member.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-transparent bg-background/80 px-2 py-1.5 transition-colors hover:border-border/60"
                  >
                    <div className="min-w-0 flex-1">
                      {editingMemberNameId === member.id ? (
                        <input
                          value={editingMemberNameValue}
                          onChange={(event) => setEditingMemberNameValue(event.target.value)}
                          onBlur={() => {
                            void renameHouseholdMember(member.id, editingMemberNameValue)
                            setEditingMemberNameId(null)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault()
                              void renameHouseholdMember(member.id, editingMemberNameValue)
                              setEditingMemberNameId(null)
                            } else if (event.key === "Escape") {
                              event.preventDefault()
                              setEditingMemberNameId(null)
                            }
                          }}
                          autoFocus
                          className="w-full rounded border border-input bg-background px-2 py-0.5 text-sm font-medium"
                        />
                      ) : (
                        <p
                          className={`truncate font-medium ${canEditName ? "cursor-text hover:underline" : ""}`}
                          onDoubleClick={() => {
                            if (!canEditName) return
                            setEditingMemberNameId(member.id)
                            setEditingMemberNameValue(member.name)
                          }}
                          title={
                            canEditName
                              ? "Double-click to edit name"
                              : "Clerk-linked members can edit their own name in Clerk settings"
                          }
                        >
                          {member.name}
                        </p>
                      )}
                      <div className="mt-1">
                        {canEditRole ? (
                          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span>Role</span>
                            <select
                              value={normalizedRole === "supervisor" ? "supervisor" : "member"}
                              onChange={(event) => {
                                const value = event.target.value === "supervisor" ? "supervisor" : "member"
                                void updateMemberRole(member.id, value)
                              }}
                              className="rounded border border-input bg-background px-1.5 py-0.5 text-[11px] text-foreground"
                            >
                              <option value="member">Member</option>
                              <option value="supervisor">Supervisor</option>
                            </select>
                          </label>
                        ) : (
                          <span className="inline-flex items-center rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                            Manager
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0">
                      <div className="flex items-center gap-1">
                        {canEditRole ? (
                          <button
                            type="button"
                            className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-medium text-red-700 hover:bg-red-100"
                            onClick={() => {
                              void removeHouseholdMember(member.id, member.name)
                            }}
                            title="Remove member from household"
                            aria-label={`Remove ${member.name}`}
                          >
                            Remove
                          </button>
                        ) : null}
                        <button
                          type="button"
                          style={anchorStyles}
                          popoverTarget={popoverId}
                          popoverTargetAction="toggle"
                          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-input bg-muted/60 px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                          aria-label={`Token color for ${member.name}`}
                        >
                          <span
                            className={`h-4 w-4 shrink-0 rounded border border-zinc-300 ${
                              currentOption?.className ?? "bg-zinc-100"
                            }`}
                            aria-hidden
                          />
                          <span className="hidden sm:inline">Color</span>
                          <span className="text-[10px] text-zinc-500" aria-hidden>
                            ▾
                          </span>
                        </button>
                      </div>
                      <div
                        id={popoverId}
                        popover="auto"
                        style={popoverPositionStyles}
                        className="z-[300] w-[8.75rem] max-w-[min(8.75rem,calc(100vw-1.5rem))]"
                      >
                        <div className="rounded-lg border border-border bg-popover p-2 shadow-lg">
                          <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Token color
                          </p>
                          <div
                            className="grid w-full shrink-0 gap-2"
                            style={{ gridTemplateColumns: "repeat(4, 1.5rem)" }}
                          >
                            {TOKEN_COLOR_OPTIONS.map((option) => {
                              const active = member.token_color === option.id
                              return (
                                <button
                                  key={`${member.id}-${option.id}`}
                                  type="button"
                                  className={`box-border h-6 w-6 min-h-6 min-w-6 shrink-0 rounded border border-zinc-400/40 ${option.className} ${
                                    active
                                      ? "outline outline-2 outline-offset-1 outline-zinc-900"
                                      : "opacity-95 hover:opacity-100"
                                  }`}
                                  title={`${member.name}: ${option.id}`}
                                  onClick={() => {
                                    void updateMemberTokenColor(member.id, option.id)
                                    const el = document.getElementById(popoverId) as
                                      | (HTMLElement & { hidePopover?: () => void })
                                      | null
                                    el?.hidePopover?.()
                                  }}
                                />
                              )
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
              {localMembers.length === 0 ? <li className="text-muted-foreground">No members yet.</li> : null}
            </ul>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-muted-foreground">Join links</p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0 gap-1"
                onClick={() => {
                  void createInvite()
                }}
              >
                <Plus className="size-3.5" aria-hidden />
                Invite link
              </Button>
            </div>
            <ul className="max-h-44 space-y-2 overflow-auto">
              {localInvites
                .filter((invite) => invite.is_active)
                .map((invite) => (
                <li key={invite.id} className="rounded-lg border border-border/70 bg-muted/15 p-3 text-xs shadow-sm">
                  <p className="font-medium text-foreground">
                    /join/{invite.code}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    Uses: {invite.uses_count}/{invite.max_uses}
                  </p>
                  <p className="text-muted-foreground">
                    Expires: {formatDateStable(invite.expires_at)}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="mt-2"
                    onClick={() => {
                      void copyInviteLink(invite.code)
                    }}
                  >
                    Copy link
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="ml-2 mt-2 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
                    onClick={() => {
                      void deactivateInvite(invite.id)
                    }}
                  >
                    Delete link
                  </Button>
                </li>
              ))}
              {localInvites.filter((invite) => invite.is_active).length === 0 ? (
                <li className="rounded-lg border border-dashed border-border/80 p-3 text-xs text-muted-foreground">
                  No invites created yet.
                </li>
              ) : null}
            </ul>
          </div>
        </aside>
      ) : null}

      {activeTask ? (
        <div className="fixed bottom-4 right-6 top-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border/80 bg-card/95 p-5 shadow-2xl ring-1 ring-black/[0.04] backdrop-blur-md dark:ring-white/[0.06]">
          <h3 className="mb-1 shrink-0 text-lg font-semibold tracking-tight">Task settings</h3>
          <p className="mb-3 shrink-0 text-xs text-muted-foreground">Changes auto-save as you edit.</p>
          <form
            id="task-settings-form"
            ref={taskSettingsFormRef}
            key={activeTask.id}
            onInput={() => scheduleTaskSettingsAutosave(false)}
            onChange={() => scheduleTaskSettingsAutosave(false)}
            onBlur={() => scheduleTaskSettingsAutosave(true)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="space-y-3 overflow-y-auto pr-1">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Title</label>
              <input
                name="title"
                defaultValue={activeTask.title}
                className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none transition-[box-shadow,border-color] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <select
                name="type"
                className="mt-1 w-full cursor-pointer rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                defaultValue={activeTask.is_reward ? "reward" : "task"}
              >
                <option value="task">Task</option>
                <option value="reward">Reward</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Assigned household member</label>
              <div className="mt-1 max-h-32 space-y-1 overflow-auto rounded-lg border border-border/70 bg-muted/20 p-2">
                {localMembers.map((member) => {
                  const assignedIds = localTaskAssignees
                    .filter((assignment) => assignment.task_id === activeTask.id)
                    .map((assignment) => assignment.user_id)
                  const checked = assignedIds.includes(member.id)
                  return (
                    <label key={member.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="assigneeIds"
                        value={member.id}
                        defaultChecked={checked}
                      />
                      {member.name}
                    </label>
                  )
                })}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Notes</label>
              <textarea
                name="notes"
                defaultValue={activeTask.description ?? ""}
                placeholder="Add notes for this task..."
                rows={4}
                className="mt-1 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              />
            </div>
            <div className="space-y-2 rounded-lg border border-border/70 bg-muted/15 p-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unlock settings</p>
              {activeTask.routine_occurrence_id ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Date</label>
                    <input
                      name="unlockDate"
                      type="date"
                      defaultValue={(() => {
                        const rule = activeTask.unlock_rule as { kind?: string; date?: string } | null
                        if (rule?.kind === "fixed" && typeof rule.date === "string") return rule.date
                        return toDateInputValue(activeTask.unlock_at)
                      })()}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Time</label>
                    <input
                      name="unlockTime"
                      type="time"
                      defaultValue={(() => {
                        const rule = activeTask.unlock_rule as { time?: string } | null
                        return rule?.time ?? toTimeInputValue(activeTask.unlock_at)
                      })()}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Unlock mode</label>
                  <select
                    name="unlockMode"
                    value={unlockModeSelection}
                    onChange={(event) => setUnlockModeSelection(event.target.value)}
                    className="mt-1 w-full cursor-pointer rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                  >
                    <option value="none">No time unlock rule</option>
                    <option value="after_generation_days">X days after generation</option>
                    <option value="weekday_after_generation">Nth weekday after generation</option>
                    <option value="month_day_after_generation">Day of month after generation</option>
                  </select>
                </div>
              )}
              {!activeTask.routine_occurrence_id && unlockModeSelection === "after_generation_days" ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">After days</label>
                    <input
                      name="unlockAfterDays"
                      type="number"
                      min={0}
                      defaultValue={String((activeTask.unlock_rule as { days?: number } | null)?.days ?? 0)}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Time</label>
                    <input
                      name="unlockTime"
                      type="time"
                      defaultValue={(() => {
                        const rule = activeTask.unlock_rule as { time?: string } | null
                        return rule?.time ?? ""
                      })()}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                    />
                  </div>
                </div>
              ) : null}
              {!activeTask.routine_occurrence_id && unlockModeSelection === "weekday_after_generation" ? (
                <div className="grid gap-2" style={{ gridTemplateColumns: "minmax(0,1fr) 56px minmax(0,1fr)" }}>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Weekday</label>
                    <select
                      name="unlockWeekday"
                      defaultValue={String((activeTask.unlock_rule as { weekday?: number } | null)?.weekday ?? 5)}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="0">Sunday</option>
                      <option value="1">Monday</option>
                      <option value="2">Tuesday</option>
                      <option value="3">Wednesday</option>
                      <option value="4">Thursday</option>
                      <option value="5">Friday</option>
                      <option value="6">Saturday</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Nth</label>
                    <input
                      name="unlockWeekdayNth"
                      type="number"
                      min={1}
                      defaultValue={String((activeTask.unlock_rule as { nth?: number } | null)?.nth ?? 1)}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-1.5 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Time</label>
                    <input
                      name="unlockTime"
                      type="time"
                      defaultValue={(() => {
                        const rule = activeTask.unlock_rule as { time?: string } | null
                        return rule?.time ?? ""
                      })()}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                    />
                  </div>
                </div>
              ) : null}
              {!activeTask.routine_occurrence_id && unlockModeSelection === "month_day_after_generation" ? (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Month day</label>
                    <input
                      name="unlockMonthDay"
                      type="number"
                      min={1}
                      max={31}
                      defaultValue={String((activeTask.unlock_rule as { dayOfMonth?: number } | null)?.dayOfMonth ?? 1)}
                      className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Time</label>
                    <input
                      name="unlockTime"
                      type="time"
                      defaultValue={(() => {
                        const rule = activeTask.unlock_rule as { time?: string } | null
                        return rule?.time ?? ""
                      })()}
                      className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                    />
                  </div>
                </div>
              ) : null}
              {Boolean(activeTask.routine_occurrence_id) || unlockModeSelection !== "none" ? (
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Prerequisite + time combination</label>
                  <select
                    name="unlockCombiner"
                    defaultValue={activeTask.unlock_combiner ?? "and"}
                    className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="and">AND (both required)</option>
                    <option value="or">OR (either condition unlocks)</option>
                  </select>
                </div>
              ) : null}
            </div>
            <div className="space-y-2 rounded-lg border border-border/70 bg-muted/15 p-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Expiry settings</p>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Expiry mode</label>
                <select
                  name="expiryMode"
                  value={expiryModeSelection}
                  onChange={(event) => setExpiryModeSelection(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="none">No expiry rule</option>
                  {activeTask.routine_occurrence_id ? (
                    <option value="fixed">Fixed date/time</option>
                  ) : null}
                  {!activeTask.routine_occurrence_id ? (
                    <option value="after_creation">X minutes/hours/days after creation</option>
                  ) : null}
                  <option value="after_unlock">X minutes/hours/days after unlock</option>
                  <option value="weekday_after_unlock">Nth weekday after unlock</option>
                  <option value="month_day_after_unlock">Day of month after unlock</option>
                  {!activeTask.routine_occurrence_id ? (
                    <>
                      <option value="weekday_after_generation">Nth weekday after creation</option>
                      <option value="month_day_after_generation">Day of month after creation</option>
                    </>
                  ) : null}
                </select>
              </div>
              {expiryModeSelection === "fixed" ? (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    name="expiryDate"
                    type="date"
                    defaultValue={toDateInputValue(activeTask.expires_at)}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  />
                  <input
                    name="expiryTime"
                    type="time"
                    defaultValue={(() => {
                      const rule = activeTask.expiry_rule as { time?: string } | null
                      return rule?.time ?? toTimeInputValue(activeTask.expires_at)
                    })()}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  />
                </div>
              ) : null}
              {(expiryModeSelection === "after_creation" || expiryModeSelection === "after_unlock") ? (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    name="expiryOffsetAmount"
                    type="number"
                    min={0}
                    defaultValue={String(
                      (() => {
                        const rule = activeTask.expiry_rule as
                          | { kind?: string; amount?: number; days?: number }
                          | null
                        if (rule?.kind === "after_generation_days") return rule.days ?? 0
                        return rule?.amount ?? 0
                      })(),
                    )}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  />
                  <select
                    name="expiryOffsetUnit"
                    defaultValue={String(
                      (() => {
                        const rule = activeTask.expiry_rule as { kind?: string; unit?: string } | null
                        if (rule?.kind === "after_generation_days") return "days"
                        return rule?.unit ?? "minutes"
                      })(),
                    )}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                </div>
              ) : null}
              {(expiryModeSelection === "weekday_after_generation" ||
                expiryModeSelection === "weekday_after_unlock") ? (
                <div className="grid gap-2" style={{ gridTemplateColumns: "minmax(0,1fr) 56px minmax(0,1fr)" }}>
                  <select
                    name="expiryWeekday"
                    defaultValue={String((activeTask.expiry_rule as { weekday?: number } | null)?.weekday ?? 5)}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="0">Sunday</option>
                    <option value="1">Monday</option>
                    <option value="2">Tuesday</option>
                    <option value="3">Wednesday</option>
                    <option value="4">Thursday</option>
                    <option value="5">Friday</option>
                    <option value="6">Saturday</option>
                  </select>
                  <input
                    name="expiryWeekdayNth"
                    type="number"
                    min={1}
                    defaultValue={String((activeTask.expiry_rule as { nth?: number } | null)?.nth ?? 1)}
                    className="rounded-lg border border-input bg-background px-1.5 py-2 text-sm"
                  />
                  <input
                    name="expiryTime"
                    type="time"
                    defaultValue={(() => {
                      const rule = activeTask.expiry_rule as { time?: string } | null
                      return rule?.time ?? ""
                    })()}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  />
                </div>
              ) : null}
              {(expiryModeSelection === "month_day_after_generation" ||
                expiryModeSelection === "month_day_after_unlock") ? (
                <div className="grid grid-cols-2 gap-2">
                  <input
                    name="expiryMonthDay"
                    type="number"
                    min={1}
                    max={31}
                    defaultValue={String((activeTask.expiry_rule as { dayOfMonth?: number } | null)?.dayOfMonth ?? 1)}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  />
                  <input
                    name="expiryTime"
                    type="time"
                    defaultValue={(() => {
                      const rule = activeTask.expiry_rule as { time?: string } | null
                      return rule?.time ?? ""
                    })()}
                    className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  />
                </div>
              ) : null}
            </div>
            </div>
            <div className="mt-3 flex shrink-0 flex-wrap justify-end gap-2 border-t border-border/60 pt-3">
              <p className="mr-auto self-center text-xs text-muted-foreground">
                {taskSettingsSaveState === "saving"
                  ? "Saving..."
                  : taskSettingsSaveState === "saved"
                    ? "Saved"
                    : taskSettingsSaveState === "error"
                      ? taskSettingsSaveError ?? "Save failed"
                      : "Auto-save enabled"}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void (async () => {
                    await flushTaskSettingsIfDirty()
                    setActiveTask(null)
                  })()
                }}
              >
                Close
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={activeTaskLocked}
                title={activeTaskLocked ? "Locked task cannot be deleted" : "Delete task"}
                onClick={() => {
                  if (activeTaskLocked) return
                  void deleteTask(activeTask)
                }}
              >
                Delete
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {edgeMenu ? (
        <div
          className="fixed z-40 min-w-[10rem] overflow-hidden rounded-xl border border-border/80 bg-popover py-1 shadow-xl ring-1 ring-black/5 dark:ring-white/10"
          style={{ left: edgeMenu.x + 8, top: edgeMenu.y + 8 }}
        >
          <button
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
            onClick={() => {
              void deleteDependency(
                edgeMenu.sourceTaskId,
                edgeMenu.targetTaskId,
                edgeMenu.edgeId,
              )
            }}
            title="Delete connector"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {routinePlusMenu ? (
        <>
          <button
            type="button"
            aria-label="Close add menu"
            className="fixed inset-0 z-30 cursor-default bg-transparent"
            onClick={() => setRoutinePlusMenu(null)}
          />
          <div
            data-routine-plus-menu
            className="fixed z-40 min-w-[12rem] overflow-hidden rounded-xl border border-border/80 bg-popover py-1 shadow-xl ring-1 ring-black/5 dark:ring-white/10"
            style={{ left: routinePlusMenu.x, top: routinePlusMenu.y }}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
              onClick={() => {
                void createOccurrence(routinePlusMenu.routineId)
                setRoutinePlusMenu(null)
              }}
            >
              Add occurrence
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
              onClick={() => {
                void addRecurrenceRule(routinePlusMenu.routineId)
              }}
            >
              Add recurrence rule
            </button>
          </div>
        </>
      ) : null}

      {guideLineMenu ? (
        <div
          className="fixed z-40 min-w-[10rem] overflow-hidden rounded-xl border border-border/80 bg-popover py-1 shadow-xl ring-1 ring-black/5 dark:ring-white/10"
          style={{ left: guideLineMenu.x + 8, top: guideLineMenu.y + 8 }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
            title={guideMenuLocked ? "Unlock line" : "Lock line"}
            onClick={() => {
              const id = guideLineMenu.nodeId
              setFlowNodes((nds) => {
                const next = nds.map((n) => {
                  if (n.id !== id || n.type !== "dayDivider") return n
                  const data = n.data as DayDividerData
                  const locked = !Boolean(data.locked)
                  return {
                    ...n,
                    draggable: !locked,
                    data: { ...data, locked },
                  }
                })
                saveGuideNodes(
                  guideStorageKeyMemo,
                  next.filter((n) => n.type === "dayDivider") as Node<DayDividerData>[],
                )
                return next
              })
              setGuideLineMenu(null)
            }}
          >
            {guideMenuLocked ? <LockOpen className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
          </button>
          <button
            type="button"
            disabled={guideMenuLocked}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
              guideMenuLocked
                ? "cursor-not-allowed text-muted-foreground opacity-50"
                : "text-destructive hover:bg-destructive/10",
            )}
            title="Delete line"
            onClick={() => {
              if (guideMenuLocked) return
              const id = guideLineMenu.nodeId
              setFlowNodes((nds) => {
                const next = nds.filter((n) => n.id !== id)
                saveGuideNodes(
                  guideStorageKeyMemo,
                  next.filter((n) => n.type === "dayDivider") as Node<DayDividerData>[],
                )
                return next
              })
              setGuideLineMenu(null)
            }}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {occurrenceMenu ? (
        <div
          className="fixed z-40 min-w-[10rem] overflow-hidden rounded-xl border border-border/80 bg-popover py-1 shadow-xl ring-1 ring-black/5 dark:ring-white/10"
          style={{ left: occurrenceMenu.x + 8, top: occurrenceMenu.y + 8 }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
            title="Delete occurrence"
            onClick={() => {
              setOccurrenceDeleteConfirm({
                occurrenceId: occurrenceMenu.occurrenceId,
                routineId: occurrenceMenu.routineId,
              })
              setOccurrenceMenu(null)
            }}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {taskMenu ? (
        <div
          className="fixed z-40 min-w-[10rem] overflow-hidden rounded-xl border border-border/80 bg-popover py-1 shadow-xl ring-1 ring-black/5 dark:ring-white/10"
          style={{ left: taskMenu.x + 8, top: taskMenu.y + 8 }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
            title={taskMenuAllLocked ? "Unlock task" : "Lock task"}
            onClick={() => {
              toggleTaskNodeLock(taskMenu.taskIds)
              setTaskMenu(null)
            }}
          >
            {taskMenuAllLocked ? (
              <LockOpen className="h-4 w-4" />
            ) : (
              <Lock className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            disabled={taskMenuHasLockedSelection}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
              taskMenuHasLockedSelection
                ? "cursor-not-allowed text-muted-foreground opacity-50"
                : "text-destructive hover:bg-destructive/10",
            )}
            title={taskMenu.taskIds.length > 1 ? "Delete selected tasks" : "Delete task"}
            onClick={() => {
              if (taskMenuHasLockedSelection) return
              void deleteTaskIds(taskMenu.taskIds, taskMenu.occurrenceId)
              setTaskMenu(null)
            }}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {occurrenceDeleteConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-md rounded-2xl border border-border/80 bg-card p-6 shadow-2xl ring-1 ring-black/[0.06] dark:ring-white/[0.08]">
            <h3 className="text-lg font-semibold tracking-tight">Delete occurrence?</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              This will remove the occurrence and its task completion data. This cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOccurrenceDeleteConfirm(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() =>
                  void deleteOccurrence(
                    occurrenceDeleteConfirm.occurrenceId,
                    occurrenceDeleteConfirm.routineId,
                  )
                }
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}
