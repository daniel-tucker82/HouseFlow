import { Pool } from "pg"

declare global {
  var __houseflowPool: Pool | undefined
  var __houseflowKioskGatePool: Pool | undefined
}

function createPool(max = 5): Pool {
  const connectionString = process.env.POSTGRES_URL
  if (!connectionString) {
    throw new Error("Missing POSTGRES_URL environment variable.")
  }

  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    maxLifetimeSeconds: 300,
    allowExitOnIdle: true,
    ssl: connectionString.includes("localhost")
      ? undefined
      : {
          rejectUnauthorized: false,
        },
  })

  pool.on("error", (error) => {
    console.error("[db] idle PostgreSQL client error", { error })
  })

  return pool
}

/** Production pool: module singleton (original behavior without touching `global`). */
let productionPool: Pool | undefined

function getPool(): Pool {
  if (process.env.NODE_ENV !== "production") {
    if (!global.__houseflowPool) {
      global.__houseflowPool = createPool()
    }
    return global.__houseflowPool
  }
  if (!productionPool) {
    productionPool = createPool()
  }
  return productionPool
}

/**
 * Lazy `Pool` so importing this module during `next build` does not require
 * `POSTGRES_URL` until a query runs (avoids Vercel build failures when env is
 * runtime-only or missing during static analysis).
 */
export const db = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const pool = getPool()
    const value = Reflect.get(pool, prop, receiver) as unknown
    if (typeof value === "function") {
      return (value as (...args: unknown[]) => unknown).bind(pool)
    }
    return value
  },
}) as Pool

// Session admission locks live for the request. Keep their connections separate
// from the queries they protect so concurrent requests cannot exhaust their own
// working pool while waiting for another connection inside a handler.
let productionKioskGatePool: Pool | undefined
export const kioskGateDb = new Proxy({} as Pool, {
  get(_target, prop) {
    const pool = process.env.NODE_ENV === "production"
      ? productionKioskGatePool ??= createPool(2)
      : global.__houseflowKioskGatePool ??= createPool(2)
    const value = Reflect.get(pool, prop)
    return typeof value === "function" ? value.bind(pool) : value
  },
}) as Pool
