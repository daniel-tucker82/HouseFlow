/* eslint-disable @typescript-eslint/no-require-imports -- Isolated PostgreSQL and mocked billing provider; never real deletion. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { fixture, connectionString } = require('./helpers/account-deletion.cjs')
const enabled = { HOUSEHOLD_DELETION_SUBMISSION_ENABLED: 'true', HOUSEHOLD_DELETION_PROCESSING_ENABLED: 'true', STRIPE_SECRET_KEY: 'rk_test_fixture' }
async function setup(t) {
  const f = await fixture(t), lib = f.load(['lib/household-deletion.ts', 'lib/household-deletion-processing.ts'])
  return { ...f, ...lib, accept: (confirmed = true, env = enabled, userId = f.owner) => lib.acceptHouseholdDeletion(f.db, userId, f.deleting, confirmed, env),
    exists: async () => (await f.db.query('select count(*)::int n from households where id=$1', [f.deleting])).rows[0].n,
    job: async () => (await f.db.query('select * from household_deletion_requests where household_id=$1', [f.deleting])).rows[0] }
}
function provider(f, changes = {}) {
  const calls = []
  const customer = { id: 'cus_delete', object: 'customer', livemode: false, metadata: { app: 'cyntch', household_id: f.deleting } }
  return { calls, livemode: false, client: { customers: {
    retrieve: async (id, params, options) => { calls.push(['retrieve', id]); assert.equal(options.maxNetworkRetries, 0); assert.ok(options.timeout <= 8000); return changes.retrieve ? changes.retrieve(id) : customer },
    del: async id => { calls.push(['delete', id]); return changes.del ? changes.del(id) : { id, deleted: true } },
  }, subscriptions: { retrieve: async id => { calls.push(['subscription', id]); return { id, customer: 'cus_delete', livemode: false, metadata: { app: 'cyntch', household_id: f.deleting } } } } } }
}

test('household data deletion atomically retains paid billing cleanup and retries a lost provider response', { skip: !connectionString }, async t => {
  const f = await setup(t), receipt = await f.accept()
  assert.equal(receipt.state, 'pending'); assert.equal(await f.exists(), 0)
  assert.equal((await f.job()).stripe_customer_id, 'cus_delete')
  assert.equal((await f.db.query('select count(*)::int n from household_billing where household_id=$1', [f.deleting])).rows[0].n, 0)
  assert.equal((await f.db.query('select household_id from native_billing_accounts where id=$1', [f.native])).rows[0].household_id, null)
  assert.equal((await f.db.query('select count(*)::int n from users where id=$1', [f.owner])).rows[0].n, 1)
  assert.equal((await f.db.query('select count(*)::int n from households where id=$1', [f.transfer])).rows[0].n, 1)
  assert.deepEqual(await f.accept(), receipt, 'Same owner can retrieve acceptance after response loss')
  await assert.rejects(f.accept(true, enabled, f.other), e => e.status === 404)
  assert.deepEqual(await f.listHouseholdDeletions(f.db, f.other), [])
  assert.equal(JSON.stringify(await f.listHouseholdDeletions(f.db, f.owner)).includes('cus_delete'), false)
  let deleted = false
  const p = provider(f, { retrieve: id => deleted ? { id, deleted: true } : { id, livemode: false, metadata: { app: 'cyntch', household_id: f.deleting } },
    del: () => { deleted = true; throw new Error('Response lost after provider commit') } })
  assert.deepEqual(await f.processHouseholdDeletions(f.db, p), { completed: 0, retried: 1 })
  assert.equal((await f.job()).state, 'pending'); assert.equal((await f.job()).stripe_customer_id, 'cus_delete')
  await f.db.query('update household_deletion_requests set next_attempt_at=now()')
  assert.deepEqual(await f.processHouseholdDeletions(f.db, p), { completed: 1, retried: 0 })
  const done = await f.job()
  assert.equal(done.state, 'completed'); assert.equal(done.stripe_customer_id, null); assert.equal(done.stripe_subscription_id, null); assert.equal(done.stripe_livemode, null)
  assert.equal(p.calls.filter(x => x[0] === 'delete').length, 1)
})

test('unbilled household deletion completes without needing provider configuration', { skip: !connectionString }, async t => {
  const f = await setup(t)
  await f.db.query('update household_billing set stripe_customer_id=null,stripe_subscription_id=null where household_id=$1', [f.deleting])
  const receipt = await f.accept(true, { HOUSEHOLD_DELETION_SUBMISSION_ENABLED: 'true' })
  assert.equal(receipt.state, 'completed'); assert.ok(receipt.completedAt); assert.equal(await f.exists(), 0)
  assert.equal((await f.db.query('select count(*)::int n from native_subscriptions where account_id=$1', [f.native])).rows[0].n, 1, 'Store identity remains retired; deletion does not claim store cancellation')
})

test('missing consent, rollout, billing configuration, ownership and pending purchases retain the household', { skip: !connectionString }, async t => {
  const f = await setup(t)
  await assert.rejects(f.accept(false), e => e.status === 400)
  await assert.rejects(f.accept(true, {}), e => e.status === 503)
  await assert.rejects(f.accept(true, { ...enabled, STRIPE_SECRET_KEY: '' }), e => e.status === 503)
  await assert.rejects(f.accept(true, { ...enabled, HOUSEHOLD_DELETION_PROCESSING_ENABLED: 'false' }), e => e.status === 503)
  await assert.rejects(f.accept(true, enabled, f.child), e => e.status === 403)
  await f.db.query("insert into billing_purchase_attempts(id,household_id,user_id,session_id,provider,environment,billing_interval,expires_at,integration_suffix) values($1,$2,$3,$4,'stripe','sandbox','monthly',now()+interval '1 hour','abcdefgh')", [randomUUID(), f.deleting, f.owner, f.scope.sessionId])
  await assert.rejects(f.accept(), e => e.status === 409)
  assert.equal(await f.exists(), 1); assert.equal(await f.job(), undefined)
})

test('a failed data cascade rolls back the cleanup receipt and leaves billing bound', { skip: !connectionString }, async t => {
  const f = await setup(t)
  await f.db.query("create function block_fixture_delete() returns trigger language plpgsql as $$ begin raise exception 'fixture failure'; end $$; create trigger fixture_delete_failure before delete on households for each row execute function block_fixture_delete()")
  await assert.rejects(f.accept(), /fixture failure/)
  assert.equal(await f.exists(), 1); assert.equal(await f.job(), undefined)
  assert.equal((await f.db.query('select stripe_customer_id from household_billing where household_id=$1', [f.deleting])).rows[0].stripe_customer_id, 'cus_delete')
})

test('provider environment, metadata, unknown 404 and a rebound customer all fail closed', { skip: !connectionString }, async t => {
  const f = await setup(t); await f.accept()
  const cases = [provider(f), provider(f, { retrieve: id => ({ id, livemode: false, metadata: { app: 'cyntch', household_id: f.transfer } }) }),
    provider(f, { retrieve: () => { const error = new Error('No such customer'); error.statusCode = 404; throw error } })]
  cases[0].livemode = true
  for (const p of cases) {
    await f.db.query('update household_deletion_requests set next_attempt_at=now()')
    assert.equal((await f.processHouseholdDeletions(f.db, p)).retried, 1)
    assert.equal(p.calls.filter(x => x[0] === 'delete').length, 0); assert.equal((await f.job()).state, 'pending')
  }
  await f.db.query("insert into household_billing(household_id,stripe_customer_id) values($1,'cus_delete')", [f.shared])
  await f.db.query('update household_deletion_requests set next_attempt_at=now()')
  const rebound = provider(f)
  assert.equal((await f.processHouseholdDeletions(f.db, rebound)).retried, 1); assert.deepEqual(rebound.calls, [])
})

test('subscription-only bindings discover and persist their customer before cleanup', { skip: !connectionString }, async t => {
  const f = await setup(t)
  await f.db.query('update household_billing set stripe_customer_id=null where household_id=$1', [f.deleting])
  await f.accept()
  const p = provider(f, { del: async id => { assert.equal((await f.job()).stripe_customer_id, id); return { id, deleted: true } } })
  assert.equal((await f.processHouseholdDeletions(f.db, p)).completed, 1)
  assert.deepEqual(p.calls.map(x => x[0]), ['subscription', 'retrieve', 'delete'])
})

test('concurrent workers do not share a live lease', { skip: !connectionString }, async t => {
  const f = await setup(t); await f.accept()
  let finish, entered
  const waiting = new Promise(resolve => { finish = resolve }), started = new Promise(resolve => { entered = resolve })
  const p = provider(f, { retrieve: async id => { entered(); await waiting; return { id, deleted: true } } })
  const first = f.processHouseholdDeletions(f.db, p)
  await started
  assert.deepEqual(await f.processHouseholdDeletions(f.db, p), { completed: 0, retried: 0 })
  finish(); assert.equal((await first).completed, 1)
  assert.equal(p.calls.length, 1)
})

test('a timed-out provider read cannot launch a late DELETE and its lease is recoverable', { skip: !connectionString }, async t => {
  const f = await setup(t); await f.accept()
  let finish
  const waiting = new Promise(resolve => { finish = resolve })
  const p = provider(f, { retrieve: async id => { await waiting; return { id, livemode: false, metadata: { app: 'cyntch', household_id: f.deleting } } } })
  const started = performance.now()
  const outcome = await f.processHouseholdDeletions(f.db, p, 650)
  assert.ok(performance.now() - started < 2000)
  assert.equal(outcome.completed, 0); assert.equal((await f.job()).state, 'pending'); assert.ok((await f.job()).lease_id)
  finish(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(p.calls.filter(x => x[0] === 'delete').length, 0)
  await f.db.query("update household_deletion_requests set lease_until=now()-interval '1 second'")
  const recovered = provider(f)
  assert.equal((await f.processHouseholdDeletions(f.db, recovered)).completed, 1)
})

test('native HTTP deletion requires consent and owner access, is kiosk protected, and returns an account-scoped receipt', { skip: !connectionString }, async t => {
  const f = await setup(t), previous = Object.fromEntries(Object.keys(enabled).map(key => [key, process.env[key]]))
  Object.assign(process.env, enabled)
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const mocks = { 'next/server': { NextResponse: { json: Response.json }, after() {} } }
  const { POST } = f.load(['app/api/leader/flow/route.ts'], mocks)
  const { GET } = f.load(['app/api/mobile/household-deletions/route.ts'], mocks)
  const { MobileApi } = f.load(['mobile/src/services/api.ts'])
  const oldFetch = global.fetch
  global.fetch = (url, init) => { assert.equal(new URL(url).origin, 'https://fixture.cyntch.test'); return (init.method === 'POST' ? POST : GET)(new Request(url, init)) }
  t.after(() => { global.fetch = oldFetch })
  const api = new MobileApi('https://fixture.cyntch.test', f.owner, f.scope.deviceId, async () => 'fixture', async () => f.secret, f.scope.sessionId)
  await assert.rejects(api.request('/api/leader/flow', { action: 'deleteHousehold', householdId: f.deleting }), e => e.status === 400)
  assert.equal(await f.exists(), 1)
  const kiosk = randomUUID()
  await f.db.query('insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array[$2],array[$2],$6,$6)',
    [kiosk, f.owner, f.scope.sessionId, f.scope.deviceId, f.deleting, 'b'.repeat(64)])
  await assert.rejects(api.deleteHousehold(f.deleting), e => e.status === 423)
  await assert.rejects(api.householdDeletions(), e => e.status === 423)
  await f.db.query("update native_kiosk_sessions set state='unlocked',ended_at=now() where id=$1", [kiosk])
  const receipt = await api.deleteHousehold(f.deleting)
  assert.equal(receipt.state, 'pending'); assert.equal(await f.exists(), 0)
  assert.deepEqual(await api.deleteHousehold(f.deleting), receipt)
  assert.deepEqual(await api.householdDeletions(), [receipt])
  f.identity.userId = null
  assert.equal((await GET(new Request('https://fixture.cyntch.test/api/mobile/household-deletions'))).status, 401)
})

test('household cleanup cron rejects missing/wrong authentication before doing any work', async t => {
  const path = require('node:path'), Module = require('node:module'), { buildSync } = require('esbuild')
  const loaded = new Module(__filename, module); let calls = 0
  loaded.require = name => name === '@/lib/run-household-deletions' ? { runHouseholdDeletions: async () => { calls++; return { ok: true } } } : require(name)
  loaded._compile(buildSync({ stdin: { contents: 'export * from "./app/api/internal/household-deletions/route"', resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['@/lib/run-household-deletions'] }).outputFiles[0].text, __filename)
  const previous = process.env.CRON_SECRET
  t.after(() => { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous })
  const send = value => loaded.exports.GET(new Request('https://fixture.cyntch.test/api/internal/household-deletions', { headers: value ? { authorization: value } : {} }))
  delete process.env.CRON_SECRET; assert.equal((await send()).status, 503)
  process.env.CRON_SECRET = 'household-fixture-secret'
  assert.equal((await send()).status, 401); assert.equal((await send('Bearer incorrect')).status, 401); assert.equal(calls, 0)
  assert.equal((await send('Bearer household-fixture-secret')).status, 200); assert.equal(calls, 1)
})
