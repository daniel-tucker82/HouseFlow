import { db } from "@/lib/db"

let ensureRoutineColumnsPromise: Promise<void> | null = null

export async function ensureRoutineSchemaColumns() {
  if (!ensureRoutineColumnsPromise) {
    ensureRoutineColumnsPromise = (async () => {
      await db.query(
        `alter table routines
         add column if not exists complete_older_occurrences_on_new boolean not null default false`,
      )
    })().catch((error) => {
      ensureRoutineColumnsPromise = null
      throw error
    })
  }
  await ensureRoutineColumnsPromise
}
