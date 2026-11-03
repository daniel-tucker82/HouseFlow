import { createHash, randomUUID } from "node:crypto"
import type { PoolClient } from "pg"
import type { CompletionResult, CompletionVersion } from "@/shared/mobile/contracts"
import { compareCompletionVersions } from "@/shared/mobile/sync-policy"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export class CompletionOperationError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function parseCompletionOperation(body: Record<string, unknown>, userId: string, now = Date.now()) {
  const input = body.clientOperation as Record<string, unknown> | undefined
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) ||
    typeof input.id !== "string" || !uuid.test(input.id) ||
    typeof input.deviceId !== "string" || !uuid.test(input.deviceId) ||
    typeof input.sequence !== "number" || !Number.isSafeInteger(input.sequence) || input.sequence < 1 ||
    typeof input.correctedTimeMs !== "number" || !Number.isSafeInteger(input.correctedTimeMs) || input.correctedTimeMs < 0)) {
    throw new CompletionOperationError("Invalid completion operation")
  }
  const version: CompletionVersion = input ? {
    operationId: input.id as string, deviceId: `${userId}:${input.deviceId}`, sequence: input.sequence as number,
    correctedTimeMs: Math.min(input.correctedTimeMs as number, now),
  } : { operationId: randomUUID(), deviceId: `web:${userId}`, sequence: now, correctedTimeMs: now }
  const requestHash = createHash("sha256").update(JSON.stringify({
    householdId: body.householdId, occurrenceId: body.occurrenceId, taskId: body.taskId,
    completed: body.completed, actorMemberId: body.actorMemberId ?? userId,
    // Original corrected timestamp is frozen by the client; use it rather than the arrival-time clamp.
    clientOperation: input ? { id: input.id, deviceId: input.deviceId, sequence: input.sequence, correctedTimeMs: input.correctedTimeMs } : null,
  })).digest("hex")
  return { version, requestHash, isClientOperation: Boolean(input) }
}

type Operation = ReturnType<typeof parseCompletionOperation>

export async function findCompletionReceipt(client: PoolClient, userId: string, operation: Operation) {
  if (!operation.isClientOperation) return null
  const result = await client.query<{ request_hash: string; result: CompletionResult }>(
    "select request_hash, result from completion_operations where user_id = $1 and operation_id = $2::uuid",
    [userId, operation.version.operationId])
  if (!result.rows[0]) return null
  if (result.rows[0].request_hash !== operation.requestHash) throw new CompletionOperationError("Operation ID was already used for a different change", 409)
  if ((result.rows[0].result as CompletionResult & {dataRemoved?:boolean}).dataRemoved) throw new CompletionOperationError("This saved response included data that has been removed. Refresh the household.",410)
  return result.rows[0].result
}

export async function claimCompletionVersion(client: PoolClient, occurrenceId: string, taskId: string, operation: Operation) {
  // The caller holds the occurrence row lock before reading or changing any completion state.
  const stream = await client.query<{ sequence: string; corrected_time_ms: string }>(
    "select sequence, corrected_time_ms from completion_stream_versions where occurrence_id = $1 and task_id = $2 and device_id = $3",
    [occurrenceId, taskId, operation.version.deviceId])
  const previous = stream.rows[0]
  if (previous && Number(previous.sequence) >= operation.version.sequence) return false
  if (previous) operation.version.correctedTimeMs = Math.max(operation.version.correctedTimeMs, Number(previous.corrected_time_ms))
  await client.query(`insert into completion_stream_versions(occurrence_id, task_id, device_id, sequence, corrected_time_ms)
    values ($1, $2, $3, $4, $5) on conflict(occurrence_id, task_id, device_id)
    do update set sequence = excluded.sequence, corrected_time_ms = excluded.corrected_time_ms`,
  [occurrenceId, taskId, operation.version.deviceId, operation.version.sequence, operation.version.correctedTimeMs])
  const current = await client.query<{ operation_id: string; device_id: string; sequence: string; corrected_time_ms: string }>(
    "select * from completion_versions where occurrence_id = $1 and task_id = $2", [occurrenceId, taskId])
  const row = current.rows[0]
  if (row && compareCompletionVersions(operation.version, { operationId: row.operation_id, deviceId: row.device_id,
    sequence: Number(row.sequence), correctedTimeMs: Number(row.corrected_time_ms) }) <= 0) return false
  await client.query(`insert into completion_versions(occurrence_id, task_id, operation_id, device_id, sequence, corrected_time_ms)
    values ($1, $2, $3, $4, $5, $6) on conflict(occurrence_id, task_id)
    do update set operation_id = excluded.operation_id, device_id = excluded.device_id,
      sequence = excluded.sequence, corrected_time_ms = excluded.corrected_time_ms`,
  [occurrenceId, taskId, operation.version.operationId, operation.version.deviceId, operation.version.sequence, operation.version.correctedTimeMs])
  return true
}

export async function recordCompletionReceipt(client: PoolClient, userId: string, householdId: string, operation: Operation, result: CompletionResult) {
  if (!operation.isClientOperation) return
  await client.query(`insert into completion_operations(user_id, operation_id, household_id, request_hash, result)
    values ($1, $2::uuid, $3::uuid, $4, $5::jsonb)`,
  [userId, operation.version.operationId, householdId, operation.requestHash, JSON.stringify(result)])
}
