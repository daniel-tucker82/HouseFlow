"use client"

import { useMemo, useState, type ReactNode } from "react"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { cn } from "@/lib/utils"

const AVAIL_PREFIX = "avail:"
const BOARD_PREFIX = "board:"
const DROP_AVAIL = "drop-available"
const DROP_BOARD = "drop-board"

/** Shorter rows + gap-1 + p-2 + taller list max: ~5–6 rows before scroll (depends on font). */
const MEMBER_TILE_ROW =
  "flex min-h-[34px] items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium leading-tight shadow-sm"
const LIST_SCROLL_MAX = "max-h-[min(15rem,56svh)]"

function boardKey(id: string) {
  return `${BOARD_PREFIX}${id}`
}
function availKey(id: string) {
  return `${AVAIL_PREFIX}${id}`
}

function parseDragId(s: string): { zone: "avail" | "board"; memberId: string } | null {
  if (s.startsWith(BOARD_PREFIX)) return { zone: "board", memberId: s.slice(BOARD_PREFIX.length) }
  if (s.startsWith(AVAIL_PREFIX)) return { zone: "avail", memberId: s.slice(AVAIL_PREFIX.length) }
  return null
}

type Member = { id: string; name: string }

type Props = {
  members: Member[]
  boardMemberIds: string[]
  editableMemberIds: string[]
  canConfigureEdit: boolean
  /** Household members this viewer may mark as editable on the board (draft-independent; avoids checkbox lockout). */
  editableGrantableMemberIds: string[]
  onChange: (next: { memberIds: string[]; editableMemberIds: string[] }) => void
}

function syncEditableOrder(boardIds: string[], editableSet: Set<string>) {
  return boardIds.filter((id) => editableSet.has(id))
}

function SortableBoardRow({
  member,
  checked,
  canConfigureEdit,
  disabledReason,
  onToggleEdit,
}: {
  member: Member
  checked: boolean
  canConfigureEdit: boolean
  disabledReason?: string
  onToggleEdit: (next: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: boardKey(member.id),
    data: { type: "board" as const, memberId: member.id },
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        `${MEMBER_TILE_ROW} border-border bg-background`,
        isDragging && "z-10 ring-2 ring-primary/30",
      )}
    >
      <button
        type="button"
        className="min-w-0 flex-1 touch-manipulation text-left touch-none"
        {...attributes}
        {...listeners}
      >
        <span className="block truncate">{member.name}</span>
      </button>
      {canConfigureEdit ? (
        <label className="relative z-20 flex h-8 min-w-8 shrink-0 cursor-pointer items-center justify-center pl-1 touch-manipulation">
          <span className="sr-only">Edit tasks for {member.name}</span>
          <input
            type="checkbox"
            checked={checked}
            disabled={Boolean(disabledReason)}
            title={disabledReason}
            onChange={(e) => onToggleEdit(e.target.checked)}
            className="size-4 rounded border-input accent-green-700"
          />
        </label>
      ) : null}
    </div>
  )
}

function AvailableRow({ member }: { member: Member }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: availKey(member.id),
    data: { type: "avail" as const, memberId: member.id },
  })
  const style = transform
    ? { transform: `translate3d(${Math.round(transform.x)}px,${Math.round(transform.y)}px,0)` }
    : undefined

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        `${MEMBER_TILE_ROW} border-border bg-muted/40`,
        isDragging && "opacity-40",
      )}
    >
      <button
        type="button"
        className="w-full touch-manipulation text-left touch-none"
        {...attributes}
        {...listeners}
      >
        <span className="block truncate">{member.name}</span>
      </button>
    </div>
  )
}

function DropColumn({
  id,
  label,
  labelRight,
  children,
  className,
}: {
  id: string
  label: string
  labelRight?: ReactNode
  children: React.ReactNode
  className?: string
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card/80",
        isOver && "ring-2 ring-primary/35",
        className,
      )}
    >
      <div className="shrink-0 border-b border-border px-2 py-1">
        <div className="flex min-h-[1.25rem] items-center justify-between gap-2 leading-none">
          <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {labelRight ?? null}
        </div>
      </div>
      <div
        className={`flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-2 ${LIST_SCROLL_MAX}`}
      >
        {children}
      </div>
    </div>
  )
}

export function MemberLanesDraftPicker({
  members,
  boardMemberIds,
  editableMemberIds,
  canConfigureEdit,
  editableGrantableMemberIds,
  onChange,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])

  const availableMembers = useMemo(() => {
    const onBoard = new Set(boardMemberIds)
    return members.filter((m) => !onBoard.has(m.id))
  }, [members, boardMemberIds])

  const boardMembers = useMemo(
    () => boardMemberIds.map((id) => memberById.get(id)).filter(Boolean) as Member[],
    [boardMemberIds, memberById],
  )

  const editableSet = useMemo(() => new Set(editableMemberIds), [editableMemberIds])
  const grantableEditable = useMemo(() => new Set(editableGrantableMemberIds), [editableGrantableMemberIds])

  const editableOnBoardCount = useMemo(
    () => syncEditableOrder(boardMemberIds, editableSet).length,
    [boardMemberIds, editableSet],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Avoid treating checkbox clicks as drag starts (was blocking re-check).
      activationConstraint: { distance: 12 },
    }),
  )

  const activeMember = useMemo(() => {
    if (!activeId) return null
    const parsed = parseDragId(activeId)
    if (!parsed) return null
    return memberById.get(parsed.memberId) ?? null
  }, [activeId, memberById])

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = event
    if (!over) return

    const parsed = parseDragId(String(active.id))
    if (!parsed) return

    const overStr = String(over.id)
    const overParsed = parseDragId(overStr)

    const isOverAvailZone = overStr === DROP_AVAIL || overParsed?.zone === "avail"
    const isOverBoardZone = overStr === DROP_BOARD || overParsed?.zone === "board"

    let nextBoard = [...boardMemberIds]
    const nextEditable = new Set(editableSet)

    if (parsed.zone === "board") {
      if (isOverAvailZone) {
        if (nextBoard.length <= 1) return
        nextBoard = nextBoard.filter((id) => id !== parsed.memberId)
        nextEditable.delete(parsed.memberId)
      } else if (isOverBoardZone) {
        if (overParsed?.zone === "board" && overParsed.memberId !== parsed.memberId) {
          const oldIndex = nextBoard.indexOf(parsed.memberId)
          const newIndex = nextBoard.indexOf(overParsed.memberId)
          if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return
          nextBoard = arrayMove(nextBoard, oldIndex, newIndex)
        } else if (overStr === DROP_BOARD) {
          const oldIndex = nextBoard.indexOf(parsed.memberId)
          if (oldIndex === -1 || oldIndex === nextBoard.length - 1) return
          nextBoard = arrayMove(nextBoard, oldIndex, nextBoard.length - 1)
        }
      }
    } else if (parsed.zone === "avail") {
      if (!isOverBoardZone) return
      if (nextBoard.includes(parsed.memberId)) return

      if (overParsed?.zone === "board") {
        const insertAt = nextBoard.indexOf(overParsed.memberId)
        if (insertAt === -1) nextBoard.push(parsed.memberId)
        else nextBoard.splice(insertAt, 0, parsed.memberId)
      } else {
        nextBoard.push(parsed.memberId)
      }

      if (grantableEditable.has(parsed.memberId)) {
        nextEditable.add(parsed.memberId)
      }
    }

    onChange({
      memberIds: nextBoard,
      editableMemberIds: syncEditableOrder(nextBoard, nextEditable),
    })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={({ active }) => setActiveId(String(active.id))}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex min-h-[min(220px,42svh)] gap-2">
        <DropColumn id={DROP_AVAIL} label="Available" className="min-w-0 basis-[46%]">
          {availableMembers.length === 0 ? (
            <p className="px-1 py-2 text-center text-xs text-muted-foreground">Everyone is on the board.</p>
          ) : (
            availableMembers.map((m) => <AvailableRow key={m.id} member={m} />)
          )}
        </DropColumn>

        <DropColumn
          id={DROP_BOARD}
          label="On the board"
          className="min-w-0 basis-[54%]"
          labelRight={
            canConfigureEdit ? (
              <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase leading-none tracking-wide text-muted-foreground">
                Edit
              </span>
            ) : null
          }
        >
          <SortableContext items={boardMemberIds.map(boardKey)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1">
              {boardMembers.map((m) => {
                const checked = editableSet.has(m.id)
                const mayEdit = grantableEditable.has(m.id)
                const cannotUncheck = checked && editableOnBoardCount <= 1
                return (
                  <SortableBoardRow
                    key={m.id}
                    member={m}
                    checked={checked}
                    canConfigureEdit={canConfigureEdit}
                    disabledReason={
                      !canConfigureEdit
                        ? undefined
                        : !mayEdit
                          ? "Not editable for your role"
                          : cannotUncheck
                            ? "At least one editable lane required"
                            : undefined
                    }
                    onToggleEdit={(next) => {
                      if (!canConfigureEdit) return
                      if (!mayEdit) return
                      const nextSet = new Set(editableSet)
                      if (next) {
                        nextSet.add(m.id)
                      } else {
                        if (cannotUncheck) return
                        nextSet.delete(m.id)
                      }
                      onChange({
                        memberIds: boardMemberIds,
                        editableMemberIds: syncEditableOrder(boardMemberIds, nextSet),
                      })
                    }}
                  />
                )
              })}
            </div>
          </SortableContext>
        </DropColumn>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeMember ? (
          <div className="flex min-h-[34px] min-w-[128px] items-center rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium shadow-lg">
            <span className="truncate">{activeMember.name}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
