/* eslint-disable @typescript-eslint/no-require-imports -- Real private PostgreSQL schemas and native HTTP transport. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { fixture, connectionString } = require('./helpers/account-deletion.cjs')
const { listReports, readReport, changeReport } = require('../scripts/lib/safety-report-review.cjs')

async function setup(t) {
  const f = await fixture(t)
  const previous = process.env.SAFETY_REPORTS_ENABLED
  process.env.SAFETY_REPORTS_ENABLED = 'true'
  t.after(() => { if (previous === undefined) delete process.env.SAFETY_REPORTS_ENABLED; else process.env.SAFETY_REPORTS_ENABLED = previous })
  const lib = f.load(['lib/safety-reports.ts'])
  const { GET, POST } = f.load(['app/api/mobile/safety-reports/route.ts'])
  const { MobileApi } = f.load(['mobile/src/services/api.ts'])
  const api = new MobileApi('https://fixture.cyntch.test', f.owner, f.scope.deviceId, async () => 'fixture', async () => f.secret, f.scope.sessionId)
  const oldFetch = global.fetch
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://fixture.cyntch.test/api/mobile/safety-reports')
    return (init.method === 'POST' ? POST : GET)(new Request(url, init))
  }
  t.after(() => { global.fetch = oldFetch })
  const report = () => ({ id: randomUUID(), householdId: f.deleting, kind: 'content', subject: 'Fixture task', message: 'This private fixture describes harmful content.' })
  return { ...f, ...lib, api, GET, POST, report }
}

test('private reports commit once across simultaneous requests and lost acknowledgements', { skip: !connectionString }, async t => {
  const f = await setup(t), report = f.report()
  const results = await Promise.all([f.api.sendSafetyReport(report), f.api.sendSafetyReport(report)])
  assert.deepEqual(results[0], results[1])
  assert.equal((await f.db.query('select count(*)::int n from safety_reports')).rows[0].n, 1)
  assert.equal(results[0].accountId, f.owner)
  assert.deepEqual(Object.keys(results[0]).sort(), ['accountId', 'householdId', 'id', 'receivedAt'])
  await assert.rejects(f.api.sendSafetyReport({ ...report, message: 'An altered concern must not reuse the same receipt.' }), e => e.status === 409)
  await f.db.query('delete from household_members where household_id=$1 and user_id=$2', [f.deleting, f.owner])
  assert.deepEqual(await f.api.sendSafetyReport(report), results[0], 'A retry can recover only its own receipt after membership ends')
  await assert.rejects(f.api.sendSafetyReport(f.report()), e => e.status === 403)
})

test('all household roles can report, outsiders cannot, and the route never lists private reports', { skip: !connectionString }, async t => {
  const f = await setup(t)
  for (const role of ['manager', 'supervisor', 'member']) {
    await f.db.query('update household_members set role=$1 where household_id=$2 and user_id=$3', [role, f.deleting, f.owner])
    await f.api.sendSafetyReport(f.report())
  }
  const response = await f.GET(new Request('https://fixture.cyntch.test/api/mobile/safety-reports'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { accountId: f.owner, enabled: true })
  await assert.rejects(f.api.sendSafetyReport({ ...f.report(), householdId: randomUUID() }), e => e.status === 403)
  f.identity.userId = f.other
  await assert.rejects(f.api.sendSafetyReport(f.report()), e => e.status === 403)
  f.identity.userId = null
  assert.equal((await f.GET(new Request('https://fixture.cyntch.test/api/mobile/safety-reports'))).status, 401)
})

test('disabled service, malformed reports, pending account deletion and kiosk access fail closed', { skip: !connectionString }, async t => {
  const f = await setup(t)
  process.env.SAFETY_REPORTS_ENABLED = 'false'
  await assert.rejects(f.api.safetyReportingAvailable(), e => e.status === 404)
  await assert.rejects(f.api.sendSafetyReport(f.report()), e => e.status === 404)
  process.env.SAFETY_REPORTS_ENABLED = 'true'
  for (const patch of [{ id: 'wrong' }, { kind: ['content'] }, { subject: ' ' }, { message: 'short' }, { message: 'x'.repeat(2001) }]) {
    await assert.rejects(f.api.sendSafetyReport({ ...f.report(), ...patch }), e => e.status === 400)
  }
  const form = await f.POST(new Request('https://fixture.cyntch.test/api/mobile/safety-reports', { method: 'POST', body: JSON.stringify(f.report()) }))
  assert.equal(form.status, 415, 'HTML form encodings cannot submit a concern through a cookie-authenticated session')
  const tooLarge = await f.POST(new Request('https://fixture.cyntch.test/api/mobile/safety-reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f.report(), padding: 'x'.repeat(12000) }) }))
  assert.equal(tooLarge.status, 413)
  await f.db.query('insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array[$2],array[$2],$6,$6)',
    [randomUUID(), f.owner, f.scope.sessionId, f.scope.deviceId, f.deleting, 'b'.repeat(64)])
  await assert.rejects(f.api.sendSafetyReport(f.report()), e => e.status === 423)
  await assert.rejects(f.api.safetyReportingAvailable(), e => e.status === 423)
  await f.db.query('delete from native_kiosk_sessions')
  await f.accept(await f.intent())
  await assert.rejects(f.api.sendSafetyReport(f.report()), e => e.status === 410)
  assert.equal((await f.db.query('select count(*)::int n from safety_reports')).rows[0].n, 0)
})

test('daily limit serializes concurrent report IDs and never counts a receipt retry twice', { skip: !connectionString }, async t => {
  const f = await setup(t), first = f.report()
  await f.api.sendSafetyReport(first)
  for (let i = 1; i < 19; i++) await f.api.sendSafetyReport(f.report())
  const results = await Promise.allSettled([f.api.sendSafetyReport(f.report()), f.api.sendSafetyReport(f.report())])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  assert.equal(results.find(x => x.status === 'rejected').reason.status, 429)
  await f.api.sendSafetyReport(first)
  assert.equal((await f.db.query('select count(*)::int n from safety_reports')).rows[0].n, 20)
})

test('reports survive household removal but reporter deletion removes authored concerns', { skip: !connectionString }, async t => {
  const f = await setup(t), report = f.report()
  await f.api.sendSafetyReport(report)
  const intent = await f.intent()
  await f.accept(intent)
  await f.db.query('delete from households where id=$1', [f.deleting])
  assert.equal((await f.db.query('select count(*)::int n from safety_reports where id=$1', [report.id])).rows[0].n, 1)
  const leaseId = randomUUID()
  await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1", [intent.operationId, leaseId])
  const work = (await f.db.query('select work from account_deletion_requests where id=$1', [intent.operationId])).rows[0].work
  await f.lib.deleteAccountData(f.db, { id: intent.operationId, accountId: f.owner, leaseId, work })
  assert.equal((await f.db.query('select count(*)::int n from safety_reports')).rows[0].n, 0)
})

test('private review is revision guarded and redaction removes text without breaking receipt replay', { skip: !connectionString }, async t => {
  const f = await setup(t), report = f.report(), receipt = await f.api.sendSafetyReport(report)
  const list = await listReports(f.db)
  assert.equal(list.length, 1); assert.equal(list[0].subject, undefined); assert.equal(list[0].reporter_id, undefined)
  assert.equal((await readReport(f.db, report.id)).message, report.message)
  const review = { id: report.id, expectedRevision: 1, action: 'reviewing', reviewer: 'fixture_reviewer', note: 'Reviewing this disposable fixture concern.' }
  const results = await Promise.allSettled([changeReport(f.db, review), changeReport(f.db, review)])
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1)
  await changeReport(f.db, { ...review, expectedRevision: 2, action: 'resolved', note: 'Fixture only: content removal was verified in the disposable household.' })
  assert.equal((await listReports(f.db)).length, 0)
  await assert.rejects(changeReport(f.db, { ...review, expectedRevision: 3, action: 'redacted' }), /90 days/)
  await f.db.query("update safety_reports set resolved_at=now()-interval '91 days' where id=$1", [report.id])
  await changeReport(f.db, { ...review, expectedRevision: 3, action: 'redacted' })
  const redacted = await readReport(f.db, report.id)
  assert.equal(redacted.subject, null); assert.equal(redacted.message, null); assert.equal(redacted.resolution_note, null)
  assert.deepEqual(await f.api.sendSafetyReport(report), receipt)
  assert.equal((await f.db.query('select count(*)::int n from safety_report_reviews')).rows[0].n, 3)
  await assert.rejects(changeReport(f.db, { ...review, expectedRevision: 4 }), /not allowed/)
})
