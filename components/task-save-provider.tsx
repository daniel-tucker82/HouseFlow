"use client"

import { useAuth } from "@clerk/nextjs"
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { TaskSaveFailure, TaskSaveQueue, type TaskSave } from "@/lib/task-save-queue"

const Context = createContext<TaskSaveQueue | null>(null)
const empty: TaskSave[] = []
const emptySnapshot = () => empty
const noSubscribe = () => () => {}

export function useTaskSaves() { return useContext(Context) }
export function useTaskSaveStatus(queue: TaskSaveQueue | null) {
  return useSyncExternalStore(queue?.subscribe ?? noSubscribe, queue?.getSnapshot ?? emptySnapshot, emptySnapshot)
}

export function TaskSaveProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth()
  const [storageError, setStorageError] = useState(false)
  const queue = useMemo(() => userId ? new TaskSaveQueue(userId, {
        // Access storage only after hydration; construction is safe during SSR.
        storage: {
          get length() { return window.localStorage.length },
          key: index => window.localStorage.key(index),
          getItem: key => window.localStorage.getItem(key),
          setItem: (key, value) => window.localStorage.setItem(key, value),
          removeItem: key => window.localStorage.removeItem(key),
        },
        lock: async work => { if (navigator.locks) await navigator.locks.request(`cyntch-task-saves:${userId}`, work); else await work() },
        send: async edit => {
          const response = await fetch("/api/leader/flow", {
            method: "POST", headers: { "Content-Type": "application/json", "X-Task-Save-User": userId },
            body: JSON.stringify(edit), keepalive: true,
          })
          const json = await response.json().catch(() => null)
          if (!response.ok) throw new TaskSaveFailure(json?.error ?? "Unable to save task changes.", response.status)
          if (!json?.task) throw new Error("The server did not confirm the task save.")
          return json.task
        },
      }) : null, [userId])
  useEffect(() => {
    if (!queue) return
    const saves = queue
    try {
      saves.start()
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reflect the browser storage connection after hydration.
      setStorageError(false)
    } catch { setStorageError(true); return }
    const sync = () => saves.sync()
    const resume = () => saves.retry()
    const flush = () => saves.flush()
    window.addEventListener("storage", sync)
    window.addEventListener("online", resume)
    window.addEventListener("pagehide", flush)
    const onVisibility = () => { if (document.visibilityState === "hidden") flush() }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      saves.stop()
      window.removeEventListener("storage", sync)
      window.removeEventListener("online", resume)
      window.removeEventListener("pagehide", flush)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [queue])

  return <Context.Provider value={queue}>
    {children}
    {storageError && <p role="alert" className="fixed bottom-4 left-4 z-[100] max-w-sm rounded-lg border bg-card p-3 text-sm shadow-lg">Task autosave needs browser storage. Enable storage and reload before editing.</p>}
    <TaskSaveNotice queue={queue} />
  </Context.Provider>
}

function TaskSaveNotice({ queue }: { queue: TaskSaveQueue | null }) {
  const jobs = useTaskSaveStatus(queue)
  const failed = jobs.find(save => save.state === "error")
  const retrying = jobs.some(save => save.state === "retrying")
  if (!jobs.length) return null
  return <div role={failed ? "alert" : "status"} className="fixed bottom-4 left-4 z-[100] max-w-sm rounded-lg border bg-card px-4 py-3 text-sm shadow-lg">
    {failed ? <><p>“{failed.edit.title}” hasn’t saved: {failed.error}</p><p className="mt-1 text-xs">Your edit is kept on this device. Open the task to correct it, or retry.</p></>
      : retrying ? "Changes kept on this device. Retrying the save…" : "Saving changes…"}
    {(failed || retrying) && <button type="button" className="mt-2 underline" onClick={() => queue?.retry()}>Retry now</button>}
    {failed && <button type="button" className="ml-4 mt-2 underline" onClick={() => {
      if (!window.confirm(`Discard the unsaved edit to “${failed.edit.title}” and reload the saved version?`)) return
      queue?.discard(failed)
      window.location.reload()
    }}>Discard edit</button>}
  </div>
}
