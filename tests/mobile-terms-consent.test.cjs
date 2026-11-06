/* eslint-disable @typescript-eslint/no-require-imports -- Private-schema consent and real native transport/route checks. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { fixture, connectionString } = require('./helpers/account-deletion.cjs')
async function setup(t) {
  const f = await fixture(t), previous = process.env.TERMS_ACCEPTANCE_REQUIRED
  process.env.TERMS_ACCEPTANCE_REQUIRED = 'true'
  t.after(() => { if (previous === undefined) delete process.env.TERMS_ACCEPTANCE_REQUIRED; else process.env.TERMS_ACCEPTANCE_REQUIRED = previous })
  const mocks = { '@/lib/user-sync': { ensureCurrentUserRecord: async () => {} }, 'next/server': { NextResponse: { json: Response.json }, after() {} },
    'next/navigation': { redirect() { throw new Error('fixture_redirect') } }, 'next/cache': { revalidatePath() {} }, '@/lib/push': { dispatchPushForNotificationIds: async () => {} } }
  const { GET, POST } = f.load(['app/api/mobile/terms/route.ts'], mocks)
  const flow = f.load(['app/api/leader/flow/route.ts'], mocks)
  const join = f.load(['app/api/mobile/join/route.ts'], mocks)
  const legacy = f.load(['lib/actions/routines.ts'], mocks)
  const lib = f.load(['lib/terms-consent.ts', 'shared/terms-consent.ts'], mocks)
  const { MobileApi } = f.load(['mobile/src/services/api.ts'])
  const api = new MobileApi('https://fixture.cyntch.test', f.owner, f.scope.deviceId, async () => 'fixture', async () => f.secret, f.scope.sessionId)
  const oldFetch = global.fetch
  global.fetch = async (url, init) => {
    assert.equal(new URL(url).origin, 'https://fixture.cyntch.test')
    const route = new URL(url).pathname
    assert.ok(['/api/mobile/terms', '/api/leader/flow', '/api/mobile/join'].includes(route))
    return (route === '/api/leader/flow' ? flow.POST : route === '/api/mobile/join' ? join.POST : init.method === 'POST' ? POST : GET)(new Request(url, init))
  }
  t.after(() => { global.fetch = oldFetch })
  return { ...f, ...lib, api, GET, POST, legacy }
}

test('only explicit current-version consent commits, and a lost reply replays the same server receipt', { skip: !connectionString }, async t => {
  const f = await setup(t)
  const status = await f.api.termsStatus()
  assert.equal(status.required, true); assert.equal(status.acceptedAt, null)
  const form = await f.POST(new Request('https://fixture.cyntch.test/api/mobile/terms', { method: 'POST', body: JSON.stringify({ accountId: f.owner, version: status.version, agree: true }) }))
  assert.equal(form.status, 415, 'Cross-site HTML form encoding cannot submit a terms agreement')
  const large = await f.POST(new Request('https://fixture.cyntch.test/api/mobile/terms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(1025) }) }))
  assert.equal(large.status, 413)
  for (const body of [{ version: status.version }, { version: status.version, agree: false }, { version: '2020-01-01.1', agree: true }]) {
    await assert.rejects(f.api.request('/api/mobile/terms', { accountId: f.owner, ...body }), e => e.status === 400)
  }
  await assert.rejects(f.api.request('/api/mobile/terms', { accountId: f.other, version: status.version, agree: true }), e => e.status === 403)
  const receipts = await Promise.all([f.api.acceptTerms(status.version), f.api.acceptTerms(status.version)])
  assert.deepEqual(receipts[0], receipts[1]); assert.ok(receipts[0].acceptedAt)
  assert.deepEqual(await f.api.termsStatus(), receipts[0])
  assert.equal((await f.db.query('select count(*)::int n from terms_acceptances')).rows[0].n, 1)
  assert.equal((await f.termsStatus(f.db, f.other)).acceptedAt, null, 'Another household member does not inherit consent')
  await f.db.query('update terms_acceptances set version=$2 where user_id=$1', [f.owner, '2020-01-01.1'])
  assert.equal((await f.api.termsStatus()).acceptedAt, null, 'An earlier version is not current consent')
})

test('native and web content creation require consent, while task completion actions are excluded', { skip: !connectionString }, async t => {
  const f = await setup(t), status = await f.api.termsStatus()
  await f.db.query("update household_billing set paid_through=now()+interval '1 month' where household_id=$1", [f.deleting])
  let notices = 0
  const unsubscribe = f.api.subscribeTermsRequired(() => { notices++ })
  const before = (await f.db.query('select count(*)::int n from routines')).rows[0].n
  await assert.rejects(f.api.request('/api/leader/flow', { action: 'createRoutine', householdId: f.deleting, name: 'Fixture consent routine', type: 'recurring' }), e => e.status === 428 && e.code === 'terms_acceptance_required')
  assert.equal(notices, 1, 'A rejected save reopens the terms UI after a failed initial availability read')
  unsubscribe()
  const form = new FormData(); form.set('householdId', f.deleting); form.set('name', 'Fixture legacy routine'); form.set('type', 'recurring')
  await assert.rejects(f.legacy.createRoutine(form), e => e.status === 428)
  assert.equal((await f.db.query('select count(*)::int n from routines')).rows[0].n, before)
  assert.equal(f.sharedContentActions.has('setOccurrenceTaskCompleted'), false)
  const completion = await f.api.request('/api/leader/flow', { action: 'setOccurrenceTaskCompleted', householdId: f.deleting, occurrenceId: randomUUID(), taskId: randomUUID(), completed: true }).catch(e => e)
  assert.notEqual(completion.status, 428, 'Completion reaches its ordinary task validation without a terms check')
  await f.api.acceptTerms(status.version)
  await f.api.request('/api/leader/flow', { action: 'createRoutine', householdId: f.deleting, name: 'Fixture consent routine', type: 'recurring' })
  await assert.rejects(f.legacy.createRoutine(form), /fixture_redirect/)
  assert.equal((await f.db.query('select count(*)::int n from routines')).rows[0].n, before + 2)
})

test('joining a household checks consent before exposing a new member profile', { skip: !connectionString }, async t => {
  const f = await setup(t)
  await assert.rejects(f.api.request('/api/mobile/join', { code: 'reservedfixture' }), e => e.status === 428 && e.code === 'terms_acceptance_required')
  await f.api.acceptTerms(f.termsVersion)
  await assert.rejects(f.api.request('/api/mobile/join', { code: 'reservedfixture' }), e => e.status === 400, 'After consent ordinary invitation validation runs')
})

test('disabled rollout, unauthenticated sessions and kiosk locks cannot record an agreement', { skip: !connectionString }, async t => {
  const f = await setup(t)
  process.env.TERMS_ACCEPTANCE_REQUIRED = 'false'
  assert.equal((await f.api.termsStatus()).required, false)
  await assert.rejects(f.api.acceptTerms(f.termsVersion), e => e.status === 404)
  await f.requireTermsAcceptance(f.db, f.owner)
  process.env.TERMS_ACCEPTANCE_REQUIRED = 'true'; f.identity.userId = null
  assert.equal((await f.GET(new Request('https://fixture.cyntch.test/api/mobile/terms'))).status, 401)
  f.identity.userId = f.owner
  await f.db.query('insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array[$2],array[$2],$6,$6)',
    [randomUUID(), f.owner, f.scope.sessionId, f.scope.deviceId, f.deleting, 'b'.repeat(64)])
  await assert.rejects(f.api.acceptTerms(f.termsVersion), e => e.status === 423)
  assert.equal((await f.db.query('select count(*)::int n from terms_acceptances')).rows[0].n, 0)
})

test('account deletion removes consent records and cannot be undone through late acceptance', { skip: !connectionString }, async t => {
  const f = await setup(t)
  await f.api.acceptTerms(f.termsVersion)
  const intent = await f.intent(); await f.accept(intent)
  await assert.rejects(f.api.acceptTerms(f.termsVersion), e => e.status === 410)
  const leaseId = randomUUID()
  await f.db.query("update account_deletion_requests set lease_id=$2,lease_until=now()+interval '60 seconds' where id=$1", [intent.operationId, leaseId])
  const work = (await f.db.query('select work from account_deletion_requests where id=$1', [intent.operationId])).rows[0].work
  await f.lib.deleteAccountData(f.db, { id: intent.operationId, accountId: f.owner, leaseId, work })
  assert.equal((await f.db.query('select count(*)::int n from terms_acceptances')).rows[0].n, 0)
  await assert.rejects(f.api.acceptTerms(f.termsVersion), e => e.status === 410)
})
