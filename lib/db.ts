import { Pool } from "pg"

declare global {
  var __houseflowPool: Pool | undefined
}

function createPool(): Pool {
  const connectionString = process.env.POSTGRES_URL
  if (!connectionString) {
    throw new Error("Missing POSTGRES_URL environment variable.")
  }

  return new Pool({
    connectionString,
    ssl: connectionString.includes("localhost")
      ? undefined
      : {
          rejectUnauthorized: false,
        },
  })
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
