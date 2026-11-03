import type { PoolClient } from "pg"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validTaskEditVersion(body: Record<string, unknown>) {
  const fields = [body.saveStreamId, body.saveRevision, body.saveId]
  if (fields.every(value => value === undefined)) return true // Existing API callers.
  return typeof body.saveStreamId === "string" && uuid.test(body.saveStreamId) &&
    typeof body.saveId === "string" && uuid.test(body.saveId) &&
    typeof body.saveRevision === "number" && Number.isSafeInteger(body.saveRevision) && body.saveRevision > 0
}

/** Call inside the same transaction as the task update. Equal versions are
 * acknowledged without replaying relative time rules; older ones cannot win.
 */
export async function claimTaskEditVersion(client: PoolClient, userId: string, body: Record<string, unknown>) {
  if (body.saveStreamId === undefined) return true
  const result = await client.query(`insert into task_edit_versions (task_id, user_id, stream_id, revision, save_id)
    values ($1::uuid, $2, $3::uuid, $4::bigint, $5::uuid)
    on conflict (task_id, user_id, stream_id) do update
      set revision = excluded.revision, save_id = excluded.save_id
      where (task_edit_versions.revision, task_edit_versions.save_id) < (excluded.revision, excluded.save_id)
    returning task_id`, [body.taskId, userId, body.saveStreamId, body.saveRevision, body.saveId])
  return Boolean(result.rowCount)
}
