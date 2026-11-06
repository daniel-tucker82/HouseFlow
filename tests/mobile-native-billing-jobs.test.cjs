/* eslint-disable @typescript-eslint/no-require-imports -- Signed webhook routes and real PostgreSQL interruption/concurrency tests. */
const { test } = require('node:test'), assert = require('node:assert/strict')
const { randomUUID, createHmac } = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { buildSync } = require('esbuild'), { Pool } = require('pg')
const url = process.env.CYNTCH_TEST_DATABASE_URL, root = path.resolve(__dirname, '..')
function load(files, mocks = {}) {
  const loaded = new Module(__filename, module); loaded.require = name => mocks[name] ?? require(name)
  loaded._compile(buildSync({ stdin: { contents: files.map(file => `export * from ${JSON.stringify(path.join(root, file))}`).join(';'), resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: Object.keys(mocks) }).outputFiles[0].text, __filename)
  return loaded.exports
}
const webhook = load(['lib/native-billing-webhook.ts'])
const config = { projectId: 'proj_fixture', environment: 'production', appIds: ['app_apple', 'app_google'],
  authorization: 'Bearer ' + 'authorization-fixture-'.repeat(3), signingSecret: 'signing-fixture-'.repeat(4) }
const products = ['app_store', 'play_store'].flatMap(store => ['monthly', 'yearly'].map(interval => ({
  revenuecatProductId: `${store}_${interval}`, storeProductId: `cyntch.${store}.${interval}`, store, interval,
})))
const provider = { projectId: config.projectId, environment: 'production', v2Secret: 'fixture-v2', v1Secret: 'fixture-v1', products }
function event(accountId = randomUUID(), values = {}) {
  return { api_version: '1.0', event: { id: randomUUID(), type: 'RENEWAL', event_timestamp_ms: Date.now(),
    environment: 'PRODUCTION', app_id: 'app_apple', app_user_id: accountId, original_app_user_id: accountId, ...values } }
}
function request(body, values = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body), at = values.at ?? Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', config.signingSecret).update(`${at}.`).update(raw).digest('hex')
  return new Request('http://localhost/api/billing/native/webhook', { method: 'POST', body: values.actualBody ?? raw,
    headers: { authorization: config.authorization, 'x-revenuecat-webhook-signature': `t=${at},v1=${signature}`, ...values.headers } })
}
function providerItem(account, overrides = {}) {
  return { object: 'subscription', id: `sub_${account.id}`, customer_id: account.id, original_customer_id: account.id,
    product_id: 'app_store_monthly', environment: 'production', store: 'app_store', ownership: 'purchased', gives_access: true,
    pending_payment: false, status: 'active', auto_renewal_status: 'will_renew', ends_at: Date.now() + 86400_000, current_period_ends_at: Date.now() + 86400_000, ...overrides }
}
const response = items => Response.json({ object: 'list', items, next_page: null })

test('webhooks authenticate exact bytes and fresh delivery signatures, including retries of old lifecycle events', async () => {
  const old = event(undefined, { event_timestamp_ms: Date.now() - 7 * 86400_000 })
  assert.equal((await webhook.readNativeBillingWebhook(request(old), config)).id, old.event.id)
  for (const values of [{ headers: { authorization: 'wrong' } }, { headers: { 'x-revenuecat-webhook-signature': '' } },
    { at: Math.floor(Date.now() / 1000) - 301 }, { at: Math.floor(Date.now() / 1000) + 301 }, { actualBody: JSON.stringify(old) + ' ' }]) {
    await assert.rejects(webhook.readNativeBillingWebhook(request(old, values), config), { code: 'unauthorized' })
  }
  await assert.rejects(webhook.readNativeBillingWebhook(request('x'.repeat(262145)), config), { code: 'too_large' })
  await assert.rejects(webhook.readNativeBillingWebhook(request('{'), config), { code: 'invalid_event' })
  await assert.rejects(webhook.readNativeBillingWebhook(request(event(undefined, { transferred_to: 'not an array' })), config), { code: 'invalid_event' })
  const env = { NATIVE_BILLING_ENABLED: 'true', REVENUECAT_PROJECT_ID: config.projectId, REVENUECAT_APP_IDS: config.appIds.join(','),
    REVENUECAT_WEBHOOK_AUTHORIZATION: config.authorization, REVENUECAT_WEBHOOK_SIGNING_SECRET: config.signingSecret }
  assert.deepEqual(webhook.nativeBillingWebhookConfig(env), config)
  for (const change of [{ NATIVE_BILLING_ENABLED: 'false' }, { REVENUECAT_WEBHOOK_SIGNING_SECRET: '' }, { REVENUECAT_APP_IDS: 'one,one' },
    { NATIVE_BILLING_ENVIRONMENT: 'sandbox', VERCEL_ENV: 'production' }]) assert.throws(() => webhook.nativeBillingWebhookConfig({ ...env, ...change }), { code: 'configuration' })
})

test('identity and price-consent webhooks can omit the store environment but still require app and customer identities', async () => {
  for (const type of ['SUBSCRIBER_ALIAS', 'PRICE_INCREASE_CONSENT_REQUIRED', 'PRICE_INCREASE_CONSENT_APPROVED']) {
    const raw = event(undefined, { type, environment: undefined })
    const parsed = await webhook.readNativeBillingWebhook(request(raw), config)
    assert.equal(parsed.environment, null)
    assert.equal(parsed.appId, config.appIds[0])
    assert.deepEqual(parsed.customerIds, [raw.event.app_user_id])
    for (const changes of [{ app_id: undefined }, { app_user_id: undefined }, { environment: 'UNKNOWN' }]) {
      await assert.rejects(webhook.readNativeBillingWebhook(request({ ...raw, event: { ...raw.event, ...changes } }), config), { code: 'invalid_event' })
    }
  }
  await assert.rejects(webhook.readNativeBillingWebhook(request(event(undefined, { environment: undefined })), config), { code: 'invalid_event' })
})

async function fixture(t) {
  const destination = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(destination.hostname) && destination.pathname === '/cyntch_mobile_test')
  const schema = `billing_jobs_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`create schema ${schema}`)
  const db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 6 })
  t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  for (const name of ['app_role', 'routine_type', 'task_status', 'occurrence_status', 'notification_kind']) {
    const labels = (await admin.query(`select e.enumlabel from pg_enum e join pg_type p on p.oid=e.enumtypid join pg_namespace n on n.oid=p.typnamespace
      where p.typname=$1 and n.nspname='public' order by e.enumsortorder`, [name])).rows
    if (labels.length) await db.query(`create type ${name} as enum (${labels.map(row => "'" + row.enumlabel.replaceAll("'", "''") + "'").join(',')})`)
  }
  for (const file of fs.readdirSync(path.join(root, 'database')).filter(name => name.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(root, 'database', file), 'utf8'))
  await db.query(fs.readFileSync(path.join(root, 'database/0031_native_billing_jobs.sql'), 'utf8'))
  const lib = load(['lib/native-billing-webhook.ts', 'lib/native-billing-store.ts', 'lib/native-billing-jobs.ts', 'lib/revenuecat-native-billing.ts'])
  await db.query("insert into users(id) values('parent')")
  async function account(environment = 'production', project = config.projectId) {
    const household = (await db.query("insert into households(name,leader_id) values('Test family','parent') returning id")).rows[0].id
    return lib.ensureNativeBillingAccount(db, household, project, environment)
  }
  const owner = await account(), second = await account()
  const jobs = async () => (await db.query('select * from native_billing_jobs order by account_id')).rows
  const clear = async () => { await db.query('delete from native_billing_jobs'); await db.query('delete from native_billing_webhook_receipts') }
  const accept = body => lib.acceptNativeBillingWebhook(db, config, lib.parseNativeBillingWebhook(body))
  const drain = (fetcher = async () => response([providerItem(owner)]), options = {}) => lib.processNativeBillingJobs(db, provider, { fetcher, ...options })
  const subscriptions = async () => (await db.query('select * from native_subscriptions order by subscription_id')).rows
  return { db, lib, account, owner, second, jobs, clear, accept, drain, subscriptions }
}

test('billing webhook receipts and jobs survive retries, concurrent delivery, crashes and lifecycle changes', { skip: !url }, async t => {
  const f = await fixture(t)
  await t.test('environmentless identity and price consent events only queue configured-account verification', async () => {
    for (const type of ['SUBSCRIBER_ALIAS', 'PRICE_INCREASE_CONSENT_REQUIRED', 'PRICE_INCREASE_CONSENT_APPROVED']) {
      const raw = event(f.owner.id, { type, environment: undefined, entitlement_ids: ['premium'], expiration_at_ms: Date.now() + 86400_000 })
      const parsed = await webhook.readNativeBillingWebhook(request(raw), config)
      const accepted = await f.lib.acceptNativeBillingWebhook(f.db, config, parsed)
      assert.equal(accepted.queued, 1)
      assert.equal((await f.lib.acceptNativeBillingWebhook(f.db, config, parsed)).duplicate, true)
      assert.equal((await f.accept(event(f.owner.id, { type, environment: undefined, app_id: 'other_app' }))).outcome, 'ignored_app')
      assert.equal((await f.accept(event(f.owner.id, { type, environment: 'SANDBOX' }))).outcome, 'ignored_environment')
    }
    const jobs = await f.jobs()
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].account_id, f.owner.id)
    assert.equal(jobs[0].requested_generation, '3')
    assert.equal((await f.subscriptions()).length, 0)
    assert.equal((await f.drain(async () => response([]))).verified, 1)
    assert.equal((await f.subscriptions()).length, 0)
    await f.clear()
  })
  await t.test('concurrent duplicates enqueue once, and webhook payment claims cannot grant access', async () => {
    const raw = event(f.owner.id, { expiration_at_ms: Date.now() + 100 * 365 * 86400_000, price: 999, entitlement_ids: ['premium'] })
    const results = await Promise.all([f.accept(raw), f.accept(raw), f.accept(raw)])
    assert.equal(results.filter(value => value.duplicate).length, 2)
    const [job] = await f.jobs()
    assert.equal(job.requested_generation, '1')
    assert.equal((await f.subscriptions()).length, 0)
    await assert.rejects(f.accept({ ...raw, event: { ...raw.event, type: 'EXPIRATION' } }), { code: 'event_conflict' })
    assert.equal((await f.jobs())[0].requested_generation, '1')
    assert.equal((await f.drain()).verified, 1)
    assert.equal((await f.subscriptions())[0].gives_access, true)
    assert.equal((await f.jobs())[0].completed_generation, '1')
  })
  await t.test('receipt insertion and every affected job roll back together on storage failure', async () => {
    await f.clear()
    await f.db.query("create function fail_billing_job() returns trigger language plpgsql as $$ begin raise exception 'simulated storage failure'; end $$")
    await f.db.query('create trigger fail_billing_job before insert on native_billing_jobs for each row execute function fail_billing_job()')
    const raw = event(f.owner.id)
    await assert.rejects(f.accept(raw), /simulated storage failure/)
    assert.equal((await f.db.query('select count(*)::int n from native_billing_webhook_receipts')).rows[0].n, 0)
    await f.db.query('drop trigger fail_billing_job on native_billing_jobs')
    assert.equal((await f.accept(raw)).queued, 1)
  })
  await t.test('parallel claims exclude the same account and recover a killed worker with a newer revision', async () => {
    const claims = await Promise.all([f.lib.claimNativeBillingJob(f.db, provider), f.lib.claimNativeBillingJob(f.db, provider)])
    assert.equal(claims.filter(Boolean).length, 1)
    const old = claims.find(Boolean)
    await f.db.query("update native_billing_jobs set lease_until=now()-interval '1 second' where account_id=$1", [f.owner.id])
    const current = await f.lib.claimNativeBillingJob(f.db, provider)
    assert.ok(BigInt(current.revision) > BigInt(old.revision))
    await f.lib.applyNativeBillingSnapshot(f.db, current.id, current.revision, [])
    assert.equal(await f.lib.finishNativeBillingJob(f.db, current, { kind: 'success', nextCheckSeconds: 3600 }), true)
    const olderItems = await f.lib.fetchVerifiedNativeSubscriptions(f.owner, provider, async () => response([providerItem(f.owner)]))
    assert.deepEqual(await f.lib.applyNativeBillingSnapshot(f.db, old.id, old.revision, olderItems), { applied: false })
    assert.equal(await f.lib.finishNativeBillingJob(f.db, old, { kind: 'retry', code: 'old_worker', retrySeconds: 30 }), false)
    assert.equal((await f.jobs())[0].last_error_code, null)
    assert.equal((await f.subscriptions())[0].gives_access, false)
  })
  await t.test('a new lifecycle event arriving during verification remains queued after that worker completes', async () => {
    await f.clear(); await f.accept(event(f.owner.id))
    let ready, release
    const started = new Promise(resolve => { ready = resolve })
    const work = f.drain(() => { ready(); return new Promise(resolve => { release = resolve }) }, { limit: 1 })
    await started
    await f.accept(event(f.owner.id, { type: 'EXPIRATION' }))
    release(response([providerItem(f.owner)])); await work
    let [job] = await f.jobs()
    assert.equal(job.requested_generation, '2'); assert.equal(job.completed_generation, '1')
    assert.equal((await f.db.query('select next_attempt_at<=now() as due from native_billing_jobs where account_id=$1', [f.owner.id])).rows[0].due, true)
    await f.drain(async () => response([]))
    ;[job] = await f.jobs()
    assert.equal(job.completed_generation, '2')
    assert.equal((await f.subscriptions())[0].gives_access, false)
  })
  await t.test('provider backoff survives new events and becomes healthy after successful retry', async () => {
    await f.clear(); await f.accept(event(f.owner.id))
    const failed = await f.drain(async () => new Response('private provider details', { status: 429, headers: { 'Retry-After': '3600' } }))
    assert.equal(failed.ok, false); assert.equal(failed.retried, 1); assert.equal(failed.health.failed, 1)
    const [job] = await f.jobs()
    assert.equal(job.last_error_code, 'provider_request_429')
    assert.ok(job.next_attempt_at.getTime() >= Date.now() + 3590_000)
    await f.accept(event(f.owner.id))
    assert.equal((await f.jobs())[0].next_attempt_at.getTime(), job.next_attempt_at.getTime())
    assert.equal((await f.drain(async () => { throw new Error('must not call provider yet') })).claimed, 0)
    await f.db.query('update native_billing_jobs set next_attempt_at=now()')
    const recovered = await f.drain()
    assert.equal(recovered.ok, true); assert.equal(recovered.health.failed, 0)
    assert.equal((await f.jobs())[0].attempts, 0)
  })
  await t.test('periodic checks recover missed lifecycle events without a pending generation or open client', async () => {
    const before = (await f.jobs())[0]
    assert.equal(before.completed_generation, before.requested_generation)
    await f.db.query('update native_billing_jobs set next_attempt_at=now()')
    const result = await f.drain(async () => response([providerItem(f.owner, { gives_access: false, status: 'expired' })]))
    assert.equal(result.verified, 1)
    assert.equal((await f.subscriptions())[0].gives_access, false)
    assert.ok((await f.jobs())[0].next_attempt_at.getTime() > Date.now() + 23 * 3600_000)
  })
  await t.test('a household edit in progress makes background verification retry without waiting for that edit', async () => {
    await f.clear(); await f.accept(event(f.owner.id))
    const editing = await f.db.connect()
    try {
      await editing.query('begin')
      await editing.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [f.owner.household_id])
      const result = await f.drain()
      assert.equal(result.retried, 1)
      assert.equal((await f.jobs())[0].last_error_code, 'household_busy')
      assert.equal((await f.subscriptions())[0].gives_access, false)
    } finally { await editing.query('rollback'); editing.release() }
    await f.db.query('update native_billing_jobs set next_attempt_at=now()')
    assert.equal((await f.drain()).verified, 1)
  })
  await t.test('wrong environments/apps, dashboard tests and unknown customers cannot create verification work', async () => {
    await f.clear()
    for (const [change, outcome] of [[{ environment: 'SANDBOX' }, 'ignored_environment'], [{ app_id: 'another_app' }, 'ignored_app'],
      [{ type: 'TEST' }, 'test'], [{ type: 'EXPERIMENT_ENROLLMENT' }, 'ignored_type'], [{ app_user_id: randomUUID(), original_app_user_id: randomUUID() }, 'unknown_customer']]) {
      const receipt = await f.accept(event(f.owner.id, change)); assert.equal(receipt.outcome, outcome); assert.equal(receipt.queued, 0)
    }
    assert.equal((await f.jobs()).length, 0)
    const sandbox = await f.account('sandbox'), otherProject = await f.account('production', 'other_project')
    await f.lib.enqueueNativeBillingAccount(f.db, sandbox.id); await f.lib.enqueueNativeBillingAccount(f.db, otherProject.id)
    assert.equal((await f.drain()).claimed, 0)
  })
  await t.test('a sparse transfer event refreshes both households and cannot move paid access', async () => {
    await f.clear()
    const raw = event(undefined, { type: 'TRANSFER', app_user_id: undefined, original_app_user_id: undefined, environment: undefined, app_id: undefined,
      transferred_from: [f.owner.id], transferred_to: [f.second.id] })
    assert.equal((await f.accept(raw)).queued, 2)
    const result = await f.drain(async endpoint => new URL(endpoint).pathname.includes(f.owner.id) ? response([])
      : response([providerItem(f.second, { original_customer_id: f.owner.id })]))
    assert.equal(result.verified, 1); assert.equal(result.retried, 1)
    assert.equal((await f.subscriptions()).some(row => row.account_id === f.second.id && row.gives_access), false)
    assert.equal((await f.subscriptions()).some(row => row.account_id === f.owner.id && row.gives_access), false)
    assert.equal((await f.jobs()).find(row => row.account_id === f.second.id).last_error_code, 'provider_identity')
  })
  await t.test('retired households stop scheduled checks, and an expired batch budget starts no work', async () => {
    await f.clear()
    const retired = await f.account(); await f.lib.enqueueNativeBillingAccount(f.db, retired.id)
    assert.equal((await f.drain(undefined, { deadline: Date.now() - 1 })).claimed, 0)
    await f.db.query('delete from households where id=$1', [retired.household_id])
    const result = await f.drain(async () => { throw new Error('retired identity must not fetch') })
    assert.equal(result.retired, 1); assert.equal(result.retried, 0)
    assert.equal((await f.jobs())[0].next_attempt_at, null)
  })
  await t.test('public webhook route acknowledges only durable receipt acceptance and authenticates before touching the database', async () => {
    await f.clear()
    const callbacks = []
    const route = load(['app/api/billing/native/webhook/route.ts'], { '@/lib/db': { db: f.db }, 'next/server': { after: callback => callbacks.push(callback) },
      '@/lib/native-billing-webhook': { ...f.lib, nativeBillingWebhookConfig: () => config }, '@/lib/run-native-billing': { runNativeBilling: () => f.drain() } })
    const denied = await route.POST(request(event(f.owner.id), { headers: { authorization: 'wrong' } }))
    assert.equal(denied.status, 401); assert.equal((await f.jobs()).length, 0); assert.equal(callbacks.length, 0)
    const accepted = await route.POST(request(event(f.owner.id)))
    assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { received: true })
    assert.equal((await f.jobs()).length, 1); assert.equal(callbacks.length, 1)
    assert.equal((await f.jobs())[0].completed_generation, '0', 'HTTP acknowledgement precedes provider network work')
    await callbacks[0]()
    assert.equal((await f.jobs())[0].completed_generation, '1')
    const failing = load(['app/api/billing/native/webhook/route.ts'], { '@/lib/db': { db: { connect: async () => { throw new Error('database unavailable') } } },
      'next/server': { after: () => assert.fail('must not schedule work without persistence') },
      '@/lib/native-billing-webhook': { ...f.lib, nativeBillingWebhookConfig: () => config }, '@/lib/run-native-billing': {} })
    assert.equal((await failing.POST(request(event(f.owner.id)))).status, 503)
  })
})

test('dedicated billing cron reports application failures and rejects requests without its secret', async t => {
  const previous = process.env.CRON_SECRET
  process.env.CRON_SECRET = 'fixture-cron-secret'
  t.after(() => { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous })
  let calls = 0, ok = false
  const { GET } = load(['app/api/internal/billing/route.ts'], { '@/lib/run-native-billing': { runNativeBilling: async () => { calls++; return { enabled: true, ok } } } })
  assert.equal((await GET(new Request('http://localhost/api/internal/billing'))).status, 401); assert.equal(calls, 0)
  const cron = () => new Request('http://localhost/api/internal/billing', { headers: { authorization: 'Bearer fixture-cron-secret' } })
  assert.equal((await GET(cron())).status, 503)
  ok = true; assert.equal((await GET(cron())).status, 200)
  delete process.env.CRON_SECRET; assert.equal((await GET(cron())).status, 503); assert.equal(calls, 2)
})

test('existing household scheduler starts billing alongside recurrence work and reports its failure', async t => {
  const names = ['CRON_SECRET', 'NATIVE_BILLING_ENABLED', 'NATIVE_PUSH_ENABLED', 'STRIPE_SECRET_KEY']
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.CRON_SECRET = 'fixture-cron'; process.env.NATIVE_BILLING_ENABLED = 'true'; process.env.NATIVE_PUSH_ENABLED = 'false'; delete process.env.STRIPE_SECRET_KEY
  t.after(() => { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name] } })
  let started = false, dbQueries = 0
  const callbacks = []
  const { GET } = load(['app/api/internal/recurrence/route.ts'], {
    'next/server': { NextResponse: { json: Response.json }, after: callback => callbacks.push(callback) },
    '@clerk/nextjs/server': {},
    '@/lib/push': { dispatchPushForNotificationIds: async () => {} }, '@/lib/stripe-billing': {},
    '@/lib/db': { db: { connect: async () => Object.assign(new (require('node:events').EventEmitter)(), {
      query: async () => { assert.equal(started, true); dbQueries++; return { rowCount: 1, rows: [] } }, release() {},
    }) } },
    '@/lib/run-native-billing': { runNativeBilling: async () => { started = true; return { enabled: true, ok: false } } },
  })
  const result = await GET(new Request('http://localhost/api/cron', { headers: { authorization: 'Bearer fixture-cron' } }))
  const body = await result.json()
  assert.equal(result.status, 503); assert.equal(body.ok, false); assert.deepEqual(body.nativeBilling, { enabled: true, ok: false })
  assert.ok(dbQueries >= 2); assert.equal(callbacks.length, 2); await Promise.all(callbacks.map(callback => callback()))
})

test('scheduler response deadline reports failure while retaining the same unfinished durable billing batch', async t => {
  const names = ['CRON_SECRET', 'NATIVE_BILLING_ENABLED', 'NATIVE_PUSH_ENABLED', 'STRIPE_SECRET_KEY', 'ACCOUNT_DELETION_PROCESSING_ENABLED']
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  process.env.CRON_SECRET = 'fixture-cron'; process.env.NATIVE_BILLING_ENABLED = 'true'; process.env.NATIVE_PUSH_ENABLED = 'false'
  process.env.ACCOUNT_DELETION_PROCESSING_ENABLED = 'false'; delete process.env.STRIPE_SECRET_KEY
  t.after(() => { for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name] } })
  const deadlines = load(['lib/scheduler-deadline.ts']), callbacks = []
  let finish, calls = 0
  const pending = new Promise(resolve => { finish = resolve })
  const { GET } = load(['app/api/internal/recurrence/route.ts'], {
    'next/server': { NextResponse: { json: Response.json }, after: callback => callbacks.push(callback) },
    '@clerk/nextjs/server': {}, '@/lib/push': { dispatchPushForNotificationIds: async () => {} }, '@/lib/stripe-billing': {},
    // Scale only durations; exercise the actual route, deadline and retention.
    '@/lib/scheduler-deadline': { ...deadlines, SchedulerDeadline: class extends deadlines.SchedulerDeadline { constructor(ms) { super(ms / 100) } } },
    '@/lib/db': { db: { connect: async () => Object.assign(new (require('node:events').EventEmitter)(), {
      query: async () => ({ rowCount: 1, rows: [] }), release() {},
    }) } },
    '@/lib/run-native-billing': { runNativeBilling: () => { calls++; return pending } },
  })
  const response = await GET(new Request('http://localhost/api/cron', { headers: { authorization: 'Bearer fixture-cron' } }))
  assert.equal(response.status, 503); assert.equal((await response.json()).deadlineExceeded, true)
  assert.match(response.headers.get('cache-control'), /no-store/); assert.equal(callbacks.length, 2)
  finish({ enabled: true, ok: true }); await Promise.all(callbacks.map(callback => callback()))
  assert.equal(calls, 1, 'Response timeout must retain the existing durable batch, not launch another')
})
