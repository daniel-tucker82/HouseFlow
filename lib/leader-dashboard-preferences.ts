import { db } from "@/lib/db"

export async function getHideCompletedTasksPreference(userId: string): Promise<boolean> {
  const result = await db.query<{ hide_completed_tasks: boolean }>(
    `select hide_completed_tasks
     from leader_dashboard_preferences
     where user_id = $1`,
    [userId],
  )
  return result.rows[0]?.hide_completed_tasks ?? true
}

export async function setHideCompletedTasksPreference(userId: string, hideCompletedTasks: boolean) {
  await db.query(
    `insert into leader_dashboard_preferences (user_id, hide_completed_tasks)
     values ($1, $2)
     on conflict (user_id)
     do update set hide_completed_tasks = excluded.hide_completed_tasks,
                   updated_at = now()`,
    [userId, hideCompletedTasks],
  )
}
