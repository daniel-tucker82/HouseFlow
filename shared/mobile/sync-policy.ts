import type { CompletionVersion } from "./contracts"

/** One sample per pending batch. Never used as a prerequisite to a local save. */
export function estimateClockOffset(serverTimeMs: number, sentAtMs: number, receivedAtMs: number) {
  if (![serverTimeMs, sentAtMs, receivedAtMs].every(Number.isSafeInteger)) {
    throw new Error("Invalid server clock sample")
  }
  const roundTripMs = receivedAtMs - sentAtMs
  if (roundTripMs < 0 || roundTripMs > 30_000) {
    throw new Error("Clock changed or the time request was too slow; retry on the next sync")
  }
  return { offsetMs: serverTimeMs - Math.round((sentAtMs + receivedAtMs) / 2), uncertaintyMs: Math.ceil(roundTripMs / 2) }
}

/** Same-device causality takes precedence over a user changing the display clock. */
export function compareCompletionVersions(incoming: CompletionVersion, current: CompletionVersion): number {
  if (incoming.operationId === current.operationId) return 0
  if (incoming.deviceId === current.deviceId && incoming.sequence !== current.sequence) {
    return incoming.sequence > current.sequence ? 1 : -1
  }
  if (incoming.correctedTimeMs !== current.correctedTimeMs) {
    return incoming.correctedTimeMs > current.correctedTimeMs ? 1 : -1
  }
  // ASCII UUID ordering is deterministic across JS runtimes and database collations.
  return incoming.operationId > current.operationId ? 1 : -1
}

export function retryDelayMs(attempts: number) {
  return Math.min(60_000, 1_000 * 2 ** Math.min(6, Math.max(0, attempts)))
}
