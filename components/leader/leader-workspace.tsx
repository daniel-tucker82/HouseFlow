"use client"

import { useState, useSyncExternalStore, useTransition } from "react"
import { useRouter } from "next/navigation"
import dynamic from "next/dynamic"
import type { LeaderFlowEditorProps } from "./flow-editor"
import { MobileRoutinePlanner } from "./mobile-routine-planner"

const LeaderFlowEditor = dynamic(() => import("./flow-editor").then(module => module.LeaderFlowEditor), {
  loading: () => <p className="p-5 text-sm text-muted-foreground" role="status">Opening the canvas…</p>,
})

function subscribeToSize(callback: () => void) {
  const query = window.matchMedia("(max-width: 1024px)")
  query.addEventListener("change", callback)
  return () => query.removeEventListener("change", callback)
}

export function LeaderWorkspace({ preferredView, ...props }: LeaderFlowEditorProps & { preferredView?: "list" | "canvas" }) {
  const router = useRouter()
  const compact = useSyncExternalStore(subscribeToSize, () => window.matchMedia("(max-width: 1024px)").matches, () => false)
  const [view, setView] = useState<"list" | "canvas" | undefined>(preferredView)
  const [pending, startTransition] = useTransition()
  const showList = view ? view === "list" : compact && !props.selectedOccurrenceId
  function changeView(next: "list" | "canvas", routineId: string | null) {
    startTransition(() => {
      setView(next)
      const query = new URLSearchParams({ household: props.selectedHouseholdId, view: next })
      if (routineId) query.set("routine", routineId)
      router.replace(`/leader/dashboard?${query}`, { scroll: false })
    })
  }
  if (pending) return <p className="p-5 text-sm text-muted-foreground" role="status">Opening your routine…</p>
  return showList
    ? <MobileRoutinePlanner key={props.selectedHouseholdId} initial={props} onCanvas={routineId => changeView("canvas", routineId)} />
    : <LeaderFlowEditor {...props} onListView={routineId => changeView("list", routineId)} />
}
