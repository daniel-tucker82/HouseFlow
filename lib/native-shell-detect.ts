/**
 * Synchronous best-effort detection of the Capacitor native WebView.
 * The native runtime injects `window.Capacitor` before app JS; async `import("@capacitor/core")`
 * can lag behind first paint and caused native-only UI to never apply when SW-cached bundles load slowly.
 */
export function isCapacitorNativeShellSync(): boolean {
  if (typeof window === "undefined") return false
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } })
    .Capacitor
  if (!cap) return false
  try {
    if (cap.isNativePlatform?.() === true) return true
  } catch {
    /* ignore */
  }
  try {
    const platform = cap.getPlatform?.()
    if (platform === "ios" || platform === "android") return true
  } catch {
    /* ignore */
  }
  return false
}
