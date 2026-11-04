import type { PoolClient } from "pg"

/** The caller owns an open transaction and has already authorised the removal.
 * The deferred notification trigger records one net membership transition at
 * commit. Attach its actual cause to that transaction's captured before-image,
 * so a rollback, retry or delete/reinsert cannot leave a misleading event. */
export async function deleteHouseholdMemberships(client: PoolClient, input: {
  userId: string; householdId?: string; reason: "left" | "removed"
}) {
  const deleted = await client.query<{ household_id: string }>(
    `delete from household_members where user_id=$1
      and ($2::uuid is null or household_id=$2::uuid) returning household_id`,
    [input.userId, input.householdId ?? null],
  )
  if (deleted.rows.length) await client.query(
    `update native_notification_changes
      set before_state=before_state || jsonb_build_object('departureReason',$3::text)
      where transaction_id=pg_current_xact_id() and subject_type='member'
        and secondary_id=$1 and primary_id=any($2::uuid[]) and before_state is not null`,
    [input.userId, deleted.rows.map(row => row.household_id), input.reason],
  )
  return deleted.rowCount ?? 0
}
