import { Pool } from "pg"

declare global {
  var __houseflowPool: Pool | undefined
}

function createPool() {
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

export const db = global.__houseflowPool ?? createPool()
if (process.env.NODE_ENV !== "production") {
  global.__houseflowPool = db
}
