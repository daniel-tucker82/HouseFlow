import { Pool } from "pg"

// LISTEN is session state. The ordinary query URL may point at a transaction
// pooler, where a later transaction can run on a different database session.
export function boardListenerUrl(env = process.env): string | undefined {
  if (env.CYNTCH_BOARD_EVENTS_ENABLED !== "true") return
  const value = env.CYNTCH_BOARD_LISTEN_URL ?? env.POSTGRES_URL_NON_POOLING
  if (!value) return
  try {
    const url = new URL(value)
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
        url.hostname.split(".")[0].endsWith("-pooler") || url.searchParams.get("pgbouncer") === "true") return
    return value
  } catch { return }
}

let pool: Pool | undefined
export const boardListenDb = { async connect() {
  const connectionString = boardListenerUrl()
  if (!connectionString) throw new Error("Direct board listener is not configured.")
  if (!pool) {
    pool = new Pool({ connectionString, max: 1, application_name: "cyntch_board_listener",
      connectionTimeoutMillis: 5_000, idleTimeoutMillis: 5_000, allowExitOnIdle: true })
    pool.on("error", error => console.error("[board-events] Idle listener error", { name: error.name }))
  }
  return pool.connect()
} }
