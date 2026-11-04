import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react"
import { AccessibilityInfo, AppState } from "react-native"

// Avoid motion until the device preference has been read successfully.
const ReducedMotionContext = createContext(true)

export function MotionPreferencesProvider({ children }: PropsWithChildren) {
  const [reducedMotion, setReducedMotion] = useState(true)
  useEffect(() => {
    let mounted = true
    let revision = 0
    const refresh = () => {
      const requestedRevision = ++revision
      void AccessibilityInfo.isReduceMotionEnabled().then(enabled => {
        if (mounted && revision === requestedRevision) setReducedMotion(enabled)
      }).catch(() => {
        if (mounted && revision === requestedRevision) setReducedMotion(true)
      })
    }
    const preference = AccessibilityInfo.addEventListener("reduceMotionChanged", enabled => {
      // A delayed initial/resume read must not undo a newer system event.
      revision++
      if (mounted) setReducedMotion(enabled)
    })
    const application = AppState.addEventListener("change", state => {
      if (state === "active") refresh()
    })
    refresh()
    return () => { mounted = false; preference.remove(); application.remove() }
  }, [])
  return <ReducedMotionContext value={reducedMotion}>{children}</ReducedMotionContext>
}

export function useReducedMotion() { return useContext(ReducedMotionContext) }
