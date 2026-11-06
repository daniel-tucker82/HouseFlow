// Operator-only PostgreSQL tools; never imported into the app.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const metadata = 'id,kind,state,received_at,reviewed_at,resolved_at,redacted_at,revision'
async function listReports(db) {
  return (await db.query(`select ${metadata} from safety_reports where state <> 'resolved' order by received_at,id limit 50`)).rows
}
async function readReport(db, id) {
  if (!uuid.test(id)) throw new Error('Choose a report UUID.')
  return (await db.query(`select ${metadata},reporter_id,household_id,subject,message,resolution_note from safety_reports where id=$1`, [id])).rows[0] ?? null
}
async function changeReport(db, { id, expectedRevision, action, reviewer, note }) {
  if (!uuid.test(id) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
      || !['reviewing', 'resolved', 'redacted'].includes(action)
      || typeof reviewer !== 'string' || !/^[a-zA-Z0-9_.@-]{2,200}$/.test(reviewer)
      || (action !== 'redacted' && (typeof note !== 'string' || note.trim().length < 10 || note.length > 2000))) throw new Error('Choose a report, its current revision, a reviewer and a review note (10–2,000 characters).')
  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query("set local lock_timeout='2s'")
    const row = (await client.query("select *,resolved_at < now()-interval '90 days' as can_redact from safety_reports where id=$1 for update", [id])).rows[0]
    if (!row || row.revision !== expectedRevision) throw new Error('The report changed or no longer exists. Read it again before saving.')
    if (row.redacted_at || (action === 'resolved' && row.state !== 'reviewing') || (action === 'redacted' && (row.state !== 'resolved' || !row.can_redact))) throw new Error('This review transition is not allowed. Redaction requires a report resolved at least 90 days ago.')
    const result = action === 'redacted'
      ? await client.query(`update safety_reports set subject=null,message=null,resolution_note=null,redacted_at=clock_timestamp(),revision=revision+1 where id=$1 returning ${metadata}`, [id])
      : await client.query(`update safety_reports set state=$2,reviewed_at=clock_timestamp(),resolved_at=case when $2='resolved' then clock_timestamp() else null end,resolution_note=$3,revision=revision+1 where id=$1 returning ${metadata}`, [id, action, note.trim()])
    await client.query('insert into safety_report_reviews(report_id,revision,reviewer,action) values($1,$2,$3,$4)', [id, result.rows[0].revision, reviewer, action])
    await client.query('commit')
    return result.rows[0]
  } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
}
module.exports = { listReports, readReport, changeReport }
