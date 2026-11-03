import { createHash } from "node:crypto"
import type { PoolClient } from "pg"
import { db } from "@/lib/db"
import { normalizeRole } from "@/lib/household-authz"
import { verifyInstallation } from "@/lib/native-notification-settings"
import { defaultNotificationPreferences, notificationCatalog, type MobileNotificationKind } from "@/shared/mobile/notification-catalog"
import { notificationUuid, parseNotificationPreferences, restrictNotificationPreferences } from "@/shared/mobile/notification-settings"
import { notificationHistoryBodies, notificationHistorySelections, notificationHistoryFilterKey, type NotificationHistoryAction, type NotificationHistoryItem, type NotificationHistoryPage,
  type NotificationHistoryPoint, type NotificationHistoryScope, type NotificationHistorySource } from "@/shared/mobile/notification-history"

export class NotificationHistoryError extends Error { constructor(message: string, public status = 400, public code?: "history_household_unavailable") { super(message) } }
const zero = "00000000-0000-0000-0000-000000000000"
const timestamp = `to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
function point(value: unknown): NotificationHistoryPoint {
  const row = value as NotificationHistoryPoint | null
  if (!row || typeof row.time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.time)
    || !Number.isFinite(Date.parse(row.time)) || row.time.startsWith("0000") || new Date(row.time).toISOString() !== row.time.slice(0,23)+"Z"
    || typeof row.id !== "string" || !notificationUuid.test(row.id)) throw new NotificationHistoryError("Refresh notification history before continuing.")
  return { time: row.time, id: row.id }
}
function source(value: unknown): NotificationHistorySource {
  if (value !== "app" && value !== "web") throw new NotificationHistoryError("Choose app or website notifications.")
  return value
}
export function parseNotificationHistoryAction(input: unknown): NotificationHistoryAction {
  const row = input as Record<string, unknown> | null
  if (!row || typeof row.householdId !== "string" || !notificationUuid.test(row.householdId)) throw new NotificationHistoryError("Choose a household.")
  const common = { source: source(row.source), householdId: row.householdId }
  if (row.action === "readAll" || row.action === "dismissAll") return { ...common, action: row.action, through: point(row.through) }
  if ((row.action === "read" || row.action === "dismiss") && typeof row.notificationId === "string" && notificationUuid.test(row.notificationId)) return { ...common, action: row.action, notificationId: row.notificationId }
  throw new NotificationHistoryError("Choose a valid notification action.")
}
async function access(client: PoolClient, scope: NotificationHistoryScope, secret: string, mode: "view" | "update") {
  await verifyInstallation(client, scope.deviceId, secret)
  if ((await client.query("select 1 from native_notification_revocations where device_id=$1 and account_id=$2 and session_id=$3",[scope.deviceId,scope.accountId,scope.sessionId])).rowCount) throw new NotificationHistoryError("This sign-in session has ended.",403)
  const member = (await client.query<{ role: string; timezone: string }>(`select hm.role,h.timezone from household_members hm join households h on h.id=hm.household_id
    where hm.household_id=$1 and hm.user_id=$2`, [scope.householdId,scope.accountId])).rows[0]
  if (!member) throw new NotificationHistoryError("Household access is no longer available.",403,"history_household_unavailable")
  const role = normalizeRole(member.role)
  const members = (await client.query<{ user_id: string }>("select user_id from household_members where household_id=$1", [scope.householdId])).rows.map(row => row.user_id)
  const saved = mode === "view" ? (await client.query<{ preferences: unknown }>("select preferences from native_notification_preferences where user_id=$1 and device_id=$2 and household_id=$3",
    [scope.accountId,scope.deviceId,scope.householdId])).rows[0] : undefined
  const requested = saved ? parseNotificationPreferences(saved.preferences) : defaultNotificationPreferences(scope.accountId,member.timezone || "UTC")
  // Display choices may change before an offline read/dismiss reaches the server.
  // Authorize that saved action against current access, independently of filters.
  if (mode === "update") requested.categories = Object.fromEntries(Object.entries(notificationCatalog).map(([kind,category]) =>
    [kind,{enabled:true,memberIds:category.scope === "member" ? members : []}]))
  const preferences = restrictNotificationPreferences(requested,scope.accountId,role,members)
  // Quiet hours, OS permission and the master push switch silence alerts, not history.
  const selections = notificationHistorySelections(role, preferences)
  return { role, selections }
}
function visibleSql(stream: NotificationHistorySource) {
  return stream === "app" ? `select e.id,e.kind,e.subject->>'name' as title,null::text as body,e.occurred_at as created,
    to_char(e.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
    coalesce(s.is_read,false) or (e.occurred_at,e.id)<=(coalesce(m.read_time,'-infinity'),coalesce(m.read_id,'${zero}')) as read,
    e.subject->>'occurrenceId' as "occurrenceId",e.subject->>'taskId' as "taskId"
    from native_notification_events e
    left join native_notification_history_entries s on s.event_id=e.id and s.user_id=$2 and s.device_id=$3
    left join native_notification_history_markers m on m.household_id=e.household_id and m.user_id=$2 and m.device_id=$3
    where e.household_id=$1 and not coalesce(s.dismissed,false)
      and (e.occurred_at,e.id)>(coalesce(m.hidden_time,'-infinity'),coalesce(m.hidden_id,'${zero}'))
      and exists(select 1 from jsonb_to_recordset($4::jsonb) as selection(kind text,household boolean,members text[])
        where selection.kind=e.kind and (selection.household or e.member_ids && selection.members))`
    : `select n.id,e.kind::text,n.title,n.body,n.created_at as created,
    to_char(n.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",n.is_read as read,
    coalesce(e.subject_occurrence_id::text,e.metadata->>'occurrenceId') as "occurrenceId",
    coalesce(e.subject_task_id::text,e.subject_reward_id::text) as "taskId"
    from user_notifications n join notification_events e on e.id=n.event_id
    where e.household_id=$1 and n.user_id=$2 and not n.suppressed and $3::uuid is not null and $4::jsonb is not null
      and ($5='manager' or e.kind::text=any(case when $5='supervisor'
        then array['task_unlocked_self','task_unlocked_other','reward_unlocked_self','reward_unlocked_other']
        else array['task_unlocked_self','reward_unlocked_self'] end))`
}
function parameters(scope: NotificationHistoryScope, policy: Awaited<ReturnType<typeof access>>) { return [scope.householdId,scope.accountId,scope.deviceId,JSON.stringify(policy.selections),policy.role] }
function safeText(value: string | null, fallback: string, max: number) { return value?.replace(/[\u0000-\u001f]/g," ").trim().slice(0,max) || fallback }
function item(row: NotificationHistoryItem, stream: NotificationHistorySource): NotificationHistoryItem {
  return { id: row.id, kind: row.kind, createdAt: row.createdAt, read: row.read,
    title: safeText(row.title,stream === "app" ? notificationCatalog[row.kind as MobileNotificationKind].label : "Cyntch",180),
    body: stream === "app" ? notificationHistoryBodies[row.kind as MobileNotificationKind] : safeText(row.body,"A household update.",1000),
    ...(row.occurrenceId && notificationUuid.test(row.occurrenceId) ? { occurrenceId: row.occurrenceId } : {}),
    ...(row.taskId && notificationUuid.test(row.taskId) ? { taskId: row.taskId } : {}) }
}

export async function readNotificationHistory(scope: NotificationHistoryScope, secret: string, params: URLSearchParams): Promise<NotificationHistoryPage> {
  const stream = source(params.get("source") ?? "app"), raw = params.get("cursor")
  const client = await db.connect()
  try {
    await client.query("begin isolation level repeatable read read only")
    const policy = await access(client,scope,secret,"view")
    const key = createHash("sha256").update(JSON.stringify([scope.accountId,scope.deviceId,scope.householdId,stream,policy])).digest("hex")
    let after: NotificationHistoryPoint | null = null
    if (raw) {
      try { if (raw.length>600 || !/^[\w-]+$/.test(raw)) throw new Error(); const decoded=JSON.parse(Buffer.from(raw,"base64url").toString()); if (decoded.key!==key) throw new Error(); after=point(decoded) }
      catch { throw new NotificationHistoryError("Notification filters changed. Refresh the list.",409) }
    }
    const fetchedAt = (await client.query<{ now: string }>(`select ${timestamp} as now`)).rows[0].now
    const rows = (await client.query<NotificationHistoryItem>(`select * from (${visibleSql(stream)}${stream === "app" ? " and $5::text is not null" : ""}) visible
      where ($6::timestamptz is null or (created,id)<($6::timestamptz,$7::uuid)) order by created desc,id desc limit 26`,
    [...parameters(scope,policy),after?.time ?? null,after?.id ?? null])).rows
    const items=rows.slice(0,25).map(row=>item(row,stream)),last=items.at(-1)
    await client.query("commit")
    return { ...scope, source: stream, role: policy.role, filterKey: notificationHistoryFilterKey(policy.role, policy.selections, stream), items, fetchedAt, through: { time: fetchedAt, id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      nextCursor: rows.length>25 && last ? Buffer.from(JSON.stringify({key,time:last.createdAt,id:last.id})).toString("base64url") : null }
  } catch(error) { await client.query("rollback"); throw error } finally { client.release() }
}

export async function updateNotificationHistory(scope: NotificationHistoryScope, secret: string, action: NotificationHistoryAction) {
  const client=await db.connect()
  try {
    await client.query("begin")
    const policy=await access(client,scope,secret,"update")
    const bulk=action.action==="readAll" || action.action==="dismissAll", dismiss=action.action==="dismiss" || action.action==="dismissAll"
    if (bulk && (await client.query("select $1::timestamptz>clock_timestamp() as future",[action.through.time])).rows[0].future) throw new NotificationHistoryError("Refresh history before changing newer notifications.")
    if (action.source==="app" && bulk) {
      const column=dismiss?"hidden":"read"
      await client.query(`insert into native_notification_history_markers(user_id,device_id,household_id,${column}_time,${column}_id) values($1,$2,$3,$4,$5)
        on conflict(user_id,device_id,household_id) do update set ${column}_time=excluded.${column}_time,${column}_id=excluded.${column}_id
        where (native_notification_history_markers.${column}_time,native_notification_history_markers.${column}_id)<(excluded.${column}_time,excluded.${column}_id)`,
      [scope.accountId,scope.deviceId,scope.householdId,action.through.time,action.through.id])
    } else {
      const filter=bulk ? "(created,id)<=($6::timestamptz,$7::uuid)" : "id=$6::uuid"
      const values=[...parameters(scope,policy),...("through" in action?[action.through.time,action.through.id]:[action.notificationId])]
      const selected=`select id from (${visibleSql(action.source)}${action.source==="app"?" and $5::text is not null":""}) visible where ${filter}`
      if (action.source==="app") await client.query(`insert into native_notification_history_entries(user_id,device_id,event_id,is_read,dismissed)
        select $2,$3,id,true,${dismiss} from (${selected}) ids on conflict(user_id,device_id,event_id)
        do update set is_read=true,dismissed=native_notification_history_entries.dismissed or excluded.dismissed`,values)
      else if (dismiss) await client.query(`delete from user_notifications where user_id=$2 and id in (${selected})`,values)
      else await client.query(`update user_notifications set is_read=true,read_at=coalesce(read_at,now()) where user_id=$2 and id in (${selected})`,values)
    }
    await client.query("commit")
    return { ...scope, source: action.source, ok: true as const }
  } catch(error) { await client.query("rollback"); throw error } finally { client.release() }
}
