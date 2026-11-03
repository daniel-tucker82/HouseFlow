import type { PoolClient } from "pg"

/** Delete authored content, keeping other authors' rows out of cascading deletes.
 * Replacement containers have system text only, no departing account's name,
 * recurrence, schedule or authorship. Task IDs, assignments and status survive. */
export async function removeAccountContent(client: PoolClient, accounts: string[]) {
  const routines=(await client.query<{id:string;household_id:string}>("select id,household_id from routines where created_by=any($1::text[]) order by id for update",[accounts])).rows
  const runs=(await client.query<{id:string;household_id:string}>("select id,household_id from routine_occurrences where created_by=any($1::text[]) order by id for update",[accounts])).rows
  const tasks=(await client.query<{id:string}>("select id from tasks where created_by=any($1::text[]) order by id for update",[accounts])).rows
  const routineIds=routines.map(row=>row.id),runIds=runs.map(row=>row.id),taskIds=tasks.map(row=>row.id)
  // Runs started by another member are independent snapshots of the template.
  await client.query(`update routine_occurrences set routine_id=null,kind='manual',title=coalesce(title,'Retained household tasks')
    where routine_id=any($1::uuid[]) and not id=any($2::uuid[])`,[routineIds,runIds])
  await client.query(`update tasks set routine_id=null where routine_id=any($1::uuid[]) and routine_occurrence_id is not null
    and not routine_occurrence_id=any($2::uuid[]) and not id=any($3::uuid[])`,[routineIds,runIds,taskIds])
  for(const routine of routines) {
    const survivors=(await client.query<{id:string}>(`select id from tasks where routine_id=$1 and routine_occurrence_id is null
      and not id=any($2::uuid[]) order by id for update`,[routine.id,taskIds])).rows
    if(!survivors.length) continue
    const replacement=(await client.query<{id:string}>("insert into routines(household_id,name,type) values($1,'Retained household tasks','one_off') returning id",[routine.household_id])).rows[0].id
    await client.query("update tasks set routine_id=$1 where id=any($2::uuid[])",[replacement,survivors.map(row=>row.id)])
  }
  for(const run of runs) {
    const survivors=(await client.query<{id:string}>(`select id from tasks where routine_occurrence_id=$1 and not id=any($2::uuid[]) order by id for update`,[run.id,taskIds])).rows
    if(!survivors.length) continue
    const ids=survivors.map(row=>row.id)
    const replacement=(await client.query<{id:string}>(`insert into routine_occurrences(household_id,kind,title,scheduled_for,status)
      select $1,'manual','Retained household tasks',clock_timestamp(),case when status='cancelled' then 'cancelled'::occurrence_status
        when not exists(select 1 from occurrence_tasks where occurrence_id=$2 and task_id=any($3::uuid[]) and status<>'completed')
        then 'completed'::occurrence_status else 'active'::occurrence_status end from routine_occurrences where id=$2 returning id`,[run.household_id,run.id,ids])).rows[0].id
    await client.query("update tasks set routine_occurrence_id=$1,routine_id=null where id=any($2::uuid[])",[replacement,ids])
    await client.query("update occurrence_tasks set occurrence_id=$1 where occurrence_id=$2 and task_id=any($3::uuid[])",[replacement,run.id,ids])
    await client.query("update completion_versions set occurrence_id=$1 where occurrence_id=$2 and task_id=any($3::uuid[])",[replacement,run.id,ids])
    await client.query("update completion_stream_versions set occurrence_id=$1 where occurrence_id=$2 and task_id=any($3::uuid[])",[replacement,run.id,ids])
  }
  await client.query("delete from tasks where id=any($1::uuid[])",[taskIds])
  await client.query("delete from routine_occurrences where id=any($1::uuid[])",[runIds])
  await client.query("delete from routines where id=any($1::uuid[])",[routineIds])
  return [...routineIds,...runIds,...taskIds]
}
