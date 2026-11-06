// Explicit private support operations, never an HTTP route.
const fs = require('node:fs'), { Pool } = require('pg')
const { listReports, readReport, changeReport } = require('./lib/safety-report-review.cjs')

async function main() {
  const [command, id, revision, noteFile] = process.argv.slice(2)
  if (!['list', 'show', 'reviewing', 'resolved', 'redacted'].includes(command)) throw new Error('Usage: list | show <report-id> | reviewing/resolved <report-id> <revision> <private-note-file> | redacted <report-id> <revision>')
  if (!process.env.SAFETY_REVIEW_DATABASE_URL) throw new Error('Set SAFETY_REVIEW_DATABASE_URL explicitly; this tool does not read .env files.')
  // Use an operator-held DB credential. There is deliberately no public inbox API.
  const db = new Pool({ connectionString: process.env.SAFETY_REVIEW_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 })
  try {
    const result = command === 'list' ? await listReports(db) : command === 'show' ? await readReport(db, id) : await changeReport(db, {
      id, expectedRevision: Number(revision), action: command, reviewer: process.env.SAFETY_REVIEWER_ID,
      note: command === 'redacted' ? undefined : fs.readFileSync(noteFile, 'utf8'),
    })
    // JSON escapes control characters from untrusted user content. Keep output private.
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } finally { await db.end() }
}
main().catch(() => { process.stderr.write('Safety report operation failed. Check the explicit database, arguments and current report revision. No report text or credentials were logged.\n'); process.exitCode = 1 })
