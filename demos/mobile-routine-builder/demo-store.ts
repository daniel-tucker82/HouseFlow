import { exampleRoutine, parseSavedRoutine, STORAGE_KEY, type DemoRoutine } from "./demo-model"

type DemoStorage = Pick<Storage, "getItem" | "setItem">

/** Browser persistence is an external store. Keep a stable snapshot for React,
 * and retain edits in memory if the browser refuses a storage write.
 */
export function createDemoRoutineStore(getStorage: () => DemoStorage) {
  const serverSnapshot = { routine: exampleRoutine(), loaded: false, storageIssue: false }
  let snapshot = serverSnapshot
  const listeners = new Set<() => void>()

  const publish = (routine: DemoRoutine, storageIssue: boolean) => {
    snapshot = { routine, loaded: true, storageIssue }
    listeners.forEach(listener => listener())
  }
  const save = (routine: DemoRoutine) => {
    try {
      getStorage().setItem(STORAGE_KEY, JSON.stringify({ version: 1, routine }))
      publish(routine, false)
    } catch {
      publish(routine, true)
    }
  }

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => serverSnapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      if (!snapshot.loaded) {
        try {
          const routine = parseSavedRoutine(getStorage().getItem(STORAGE_KEY)) ?? snapshot.routine
          save(routine)
        } catch {
          publish(snapshot.routine, true)
        }
      }
      return () => { listeners.delete(listener) }
    },
    save,
  }
}
