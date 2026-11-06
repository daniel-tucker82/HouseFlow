import { createHash } from "node:crypto"
import type { Pool } from "pg"
import { withActiveAccountTransaction } from "@/lib/account-access"
import { parseSafetyReport, SafetyReportError, type SafetyReportReceipt } from "@/shared/mobile/safety-reports"

export const safetyReportsEnabled = () => process.env.SAFETY_REPORTS_ENABLED === "true"

/** A receipt is committed with the report; losing a response cannot duplicate it. */
export async function submitSafetyReport(pool: Pool, accountId: string, input: unknown): Promise<SafetyReportReceipt> {
  const report = parseSafetyReport(input)
  const hash = createHash("sha256").update(JSON.stringify(report)).digest("hex")
  return withActiveAccountTransaction(pool, accountId, async client => {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`safety-report:${report.id}`])
    const existing = (await client.query<{ reporter_id: string; request_hash: string; received_at: Date }>(
      "select reporter_id,request_hash,received_at from safety_reports where id=$1", [report.id])).rows[0]
    if (existing) {
      if (existing.reporter_id !== accountId || existing.request_hash !== hash) throw new SafetyReportError("This report reference is already in use. Start a new report.", 409)
      // This reveals only the reporter's own receipt, even after membership ends.
      return { accountId, householdId: report.householdId, id: report.id, receivedAt: existing.received_at.toISOString() }
    }
    const member = (await client.query("select 1 from household_members where household_id=$1 and user_id=$2 for share", [report.householdId, accountId])).rows[0]
    if (!member) throw new SafetyReportError("You no longer have access to this household. Your report draft is kept.", 403)
    // Serialize per reporter as well: parallel unique IDs cannot evade the cap.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`safety-reporter:${accountId}`])
    const recent = (await client.query<{ count: number }>("select count(*)::int as count from safety_reports where reporter_id=$1 and received_at>now()-interval '1 day'", [accountId])).rows[0].count
    if (recent >= 20) throw new SafetyReportError("Too many reports were sent today. Your draft is kept; try again later.", 429)
    const row = (await client.query<{ received_at: Date }>(`insert into safety_reports(id,reporter_id,household_id,kind,subject,message,request_hash)
      values($1,$2,$3,$4,$5,$6,$7) returning received_at`, [report.id,accountId,report.householdId,report.kind,report.subject,report.message,hash])).rows[0]
    return { accountId, householdId: report.householdId, id: report.id, receivedAt: row.received_at.toISOString() }
  })
}
