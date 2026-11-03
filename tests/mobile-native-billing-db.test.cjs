/* eslint-disable @typescript-eslint/no-require-imports -- Isolated PostgreSQL entitlement/restore/concurrency verification. */
const { test } = require('node:test'), assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { buildSync } = require('esbuild'), { Pool } = require('pg')
const connectionString = process.env.CYNTCH_TEST_DATABASE_URL, root = path.resolve(__dirname, '..')
function load(files, mocks = {}) {
  const loaded = new Module(__filename, module)
  loaded.require = name => mocks[name] ?? require(name)
  loaded._compile(buildSync({ stdin: { contents: files.map(file => `export * from ${JSON.stringify(path.join(root, file))}`).join(';'), resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: Object.keys(mocks) }).outputFiles[0].text, __filename)
  return loaded.exports
}

test('sandbox grants require an explicit non-production runtime; disabled billing does not query its tables', () => {
  const { nativeBillingEnvironment, nativePremiumAccessSql } = load(['lib/billing-access.ts'])
  assert.equal(nativePremiumAccessSql('h.id', {}), 'false')
  assert.equal(nativeBillingEnvironment({ NATIVE_BILLING_ENABLED: 'true' }), 'production')
  for (const env of [
    {}, { NODE_ENV: 'production' }, { NODE_ENV: 'test', VERCEL_ENV: 'production' }, { VERCEL_ENV: 'unexpected' },
  ]) assert.equal(nativeBillingEnvironment({ ...env, NATIVE_BILLING_ENABLED: 'true', NATIVE_BILLING_ENVIRONMENT: 'sandbox' }), null)
  for (const env of [{ NODE_ENV: 'test' }, { NODE_ENV: 'development' }, { NODE_ENV: 'production', VERCEL_ENV: 'preview' }]) {
    assert.equal(nativeBillingEnvironment({ ...env, NATIVE_BILLING_ENABLED: 'true', NATIVE_BILLING_ENVIRONMENT: 'sandbox' }), 'sandbox')
  }
})

test('store entitlements preserve household ownership, newest verification, web access and scheduled automation', { skip: !connectionString }, async t => {
  const target = new URL(connectionString)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
  const schema = `native_billing_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString })
  await admin.query(`create schema ${schema}`)
  const db = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 })
  t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  for (const name of ['app_role', 'routine_type', 'task_status', 'occurrence_status', 'notification_kind']) {
    const labels = (await admin.query(`select e.enumlabel from pg_enum e join pg_type p on p.oid=e.enumtypid join pg_namespace n on n.oid=p.typnamespace
      where p.typname=$1 and n.nspname='public' order by e.enumsortorder`, [name])).rows
    if (labels.length) await db.query(`create type ${name} as enum (${labels.map(row => "'" + row.enumlabel.replaceAll("'", "''") + "'").join(',')})`)
  }
  for (const file of fs.readdirSync(path.join(root, 'database')).filter(name => name.endsWith('.sql')).sort()) await db.query(fs.readFileSync(path.join(root, 'database', file), 'utf8'))
  await db.query(fs.readFileSync(path.join(root, 'database/0030_native_billing.sql'), 'utf8'))
  const previous = { ...process.env }
  process.env.NATIVE_BILLING_ENABLED = 'true'; process.env.NATIVE_BILLING_ENVIRONMENT = 'production'; process.env.FREEMIUM_ENFORCEMENT_ENABLED = 'true'
  t.after(() => { for (const key of ['NATIVE_BILLING_ENABLED', 'NATIVE_BILLING_ENVIRONMENT', 'FREEMIUM_ENFORCEMENT_ENABLED', 'FREE_HOUSEHOLD_CAP']) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]
  } })
  const clerk = { clerkClient: async () => ({ users: { getUser: async () => ({ emailAddresses: [{ emailAddress: 'parent@example.test', verification: { status: 'verified' } }] }) } }) }
  const lib = load(['lib/native-billing-store.ts', 'lib/revenuecat-native-billing.ts', 'lib/entitlements.ts', 'lib/automation-entitlements.ts', 'lib/household-admission.ts'], { '@/lib/db': { db }, '@clerk/nextjs/server': clerk })
  const hh = randomUUID(), other = randomUUID(), retired = randomUUID(), owned = randomUUID()
  for (const user of ['parent', 'other', 'retired', 'owner', 'new-parent']) await db.query('insert into users(id) values($1)', [user])
  for (const [id, user] of [[hh, 'parent'], [other, 'other'], [retired, 'retired'], [owned, 'owner']]) {
    await db.query('insert into households(id,name,leader_id) values($1,$2,$3)', [id, user + ' household', user])
    await db.query("insert into household_members(household_id,user_id,role) values($1,$2,'manager')", [id, user])
  }
  await db.query("insert into owner_entitlements(user_id,verified_email,verification_source) values('owner','owner@example.test','clerk_verified_email')")
  const account = await lib.ensureNativeBillingAccount(db, hh, 'proj_test', 'production')
  const otherAccount = await lib.ensureNativeBillingAccount(db, other, 'proj_test', 'production')
  const sandbox = await lib.ensureNativeBillingAccount(db, other, 'proj_test', 'sandbox')
  const future = new Date(Date.now() + 86400_000).toISOString(), past = new Date(Date.now() - 1000).toISOString()
  const subscription = (id = 'subscription_apple', overrides = {}) => ({ id, originalCustomerId: account.id, environment: 'production', store: 'app_store',
    productId: 'prod_monthly', status: 'active', autoRenewalStatus: 'will_renew', givesAccess: true, pendingPayment: false, accessThrough: future, ...overrides })
  async function apply(items, who = account) {
    const attempt = await lib.beginNativeBillingVerification(db, who.id)
    return lib.applyNativeBillingSnapshot(db, who.id, attempt.revision, items)
  }
  async function entitlement(id = hh) {
    const client = await db.connect()
    try { return await lib.getHouseholdEntitlement(client, id) } finally { client.release() }
  }
  await t.test('reinstallation reuses an opaque household identity; project changes cannot silently rebind it', async () => {
    assert.equal((await lib.ensureNativeBillingAccount(db, hh, 'proj_test', 'production')).id, account.id)
    assert.notEqual(account.id, hh)
    await assert.rejects(lib.ensureNativeBillingAccount(db, hh, 'proj_other', 'production'), { code: 'configuration_mismatch' })
    assert.equal((await entitlement()).tier, 'free')
  })
  await t.test('an Apple subscription grants Premium quotas and automation while a sandbox purchase grants no production access', async () => {
    await apply([subscription()])
    assert.equal((await entitlement()).tier, 'premium')
    const template = await db.query("insert into routines(household_id,name) values($1,'Run') returning id", [hh])
    await db.query("insert into tasks(household_id,routine_id,title) values($1,$2,'Task')", [hh, template.rows[0].id])
    const client = await db.connect()
    try {
      await client.query('begin')
      assert.equal(await lib.automaticGenerationAllowance(client, hh), 10)
      assert.equal((await client.query(`select (${lib.TASK_AUTOMATION_ALLOWED_SQL}) allowed from tasks t where household_id=$1 limit 1`, [hh])).rows[0].allowed, true)
      await client.query('rollback')
    } finally { client.release() }
    await apply([subscription('sandbox', { originalCustomerId: sandbox.id, environment: 'sandbox' })], sandbox)
    assert.equal((await entitlement(other)).tier, 'free')
    assert.equal((await entitlement(owned)).tier, 'owner')
  })
  await t.test('cancellation retains paid access; verified grace expires, and renewal restores access', async () => {
    await apply([subscription(undefined, { autoRenewalStatus: 'will_not_renew' })])
    assert.equal((await entitlement()).tier, 'premium')
    await apply([subscription(undefined, { status: 'in_grace_period' })])
    assert.equal((await entitlement()).tier, 'premium')
    await apply([subscription(undefined, { status: 'in_grace_period', accessThrough: past })])
    assert.equal((await entitlement()).tier, 'free')
    await apply([subscription()])
    assert.equal((await entitlement()).tier, 'premium')
  })
  await t.test('refund/revocation removes only that provider grant; Stripe and permanent owner access remain independent', async () => {
    await db.query("insert into household_billing(household_id,subscription_status,paid_through) values($1,'active',$2)", [hh, future])
    await apply([subscription(undefined, { givesAccess: false, status: 'expired' })])
    assert.equal((await entitlement()).tier, 'premium')
    await db.query("update household_billing set billing_hold='refund:test' where household_id=$1", [hh])
    assert.equal((await entitlement()).tier, 'free')
    await apply([subscription('subscription_google', { store: 'play_store' })])
    assert.equal((await entitlement()).tier, 'premium', 'a Stripe refund must not revoke separately paid Google access')
    assert.equal((await entitlement(owned)).tier, 'owner')
    assert.equal((await db.query('select count(*)::int n from tasks where household_id=$1', [hh])).rows[0].n, 1, 'downgrades preserve tasks')
  })
  await t.test('old verification, duplicate delivery and a late successful purchase response cannot undo a newer revocation', async () => {
    const old = await lib.beginNativeBillingVerification(db, account.id), newer = await lib.beginNativeBillingVerification(db, account.id)
    await lib.applyNativeBillingSnapshot(db, account.id, newer.revision, [])
    assert.deepEqual(await lib.applyNativeBillingSnapshot(db, account.id, old.revision, [subscription()]), { applied: false })
    assert.deepEqual(await lib.applyNativeBillingSnapshot(db, account.id, newer.revision, [subscription()]), { applied: false })
    assert.equal((await entitlement()).tier, 'free')
    assert.equal((await db.query('select count(*)::int n from native_subscriptions where account_id=$1', [account.id])).rows[0].n, 2, 'expired bindings survive')
    await assert.rejects(lib.applyNativeBillingSnapshot(db, account.id, String(BigInt(newer.revision) + 1n), []), { code: 'invalid_snapshot' })
  })
  await t.test('restores, transfers and mixed snapshots cannot grant another household or partially write purchases', async () => {
    await assert.rejects(apply([subscription()], otherAccount), { code: 'identity_mismatch' })
    await assert.rejects(apply([subscription('aaa-new', { originalCustomerId: otherAccount.id }), subscription(undefined, { originalCustomerId: otherAccount.id })], otherAccount), { code: 'purchase_already_bound' })
    assert.equal((await db.query('select count(*)::int n from native_subscriptions where account_id=$1', [otherAccount.id])).rows[0].n, 0)
    for (const overrides of [{ accessThrough: null }, { accessThrough: 'not a date' }, { givesAccess: 'true' }, { store: 'promotional' }]) {
      await assert.rejects(apply([subscription(undefined, overrides)]), { code: 'invalid_snapshot' })
    }
    await assert.rejects(apply([subscription(undefined, { environment: 'sandbox' })]), { code: 'identity_mismatch' })
    await assert.rejects(apply([subscription(), subscription()]), { code: 'invalid_snapshot' })
    assert.equal((await entitlement()).tier, 'free')
  })
  await t.test('provider/network interruption retains verified access without extending its expiry', async () => {
    await apply([subscription()])
    const before = await db.query('select * from native_subscriptions where subscription_id=$1', ['subscription_apple'])
    await lib.beginNativeBillingVerification(db, account.id) // Network failed: no snapshot is committed.
    const after = await db.query('select * from native_subscriptions where subscription_id=$1', ['subscription_apple'])
    assert.deepEqual(after.rows, before.rows)
    assert.equal((await entitlement()).tier, 'premium')
  })
  await t.test('actual provider-to-database path atomically commits complete snapshots and rejects interrupted or out-of-order responses', async () => {
    const config = { projectId: 'proj_test', environment: 'production', v1Secret: 'fixture-v1', v2Secret: 'fixture-v2',
      products: [{ revenuecatProductId: 'prod_monthly', storeProductId: 'cyntch.monthly', store: 'app_store', interval: 'monthly' }] }
    const response = (items, next_page = null) => Response.json({ object: 'list', items, next_page })
    const item = { object: 'subscription', id: 'subscription_apple', customer_id: account.id, original_customer_id: account.id,
      product_id: 'prod_monthly', environment: 'production', store: 'app_store', ownership: 'purchased', gives_access: true,
      pending_payment: false, status: 'active', auto_renewal_status: 'will_renew', ends_at: Date.parse(future), current_period_ends_at: Date.parse(future) }
    let release, started
    const waiting = new Promise(resolve => { started = resolve })
    const old = lib.verifyNativeBillingAccount(db, account.id, config, () => { started(); return new Promise(resolve => { release = resolve }) })
    await waiting
    await lib.verifyNativeBillingAccount(db, account.id, config, async () => response([]))
    release(response([item]))
    assert.deepEqual(await old, { applied: false })
    assert.equal((await entitlement()).tier, 'free')
    await lib.verifyNativeBillingAccount(db, account.id, config, async () => response([item]))
    assert.equal((await entitlement()).tier, 'premium')
    let calls = 0
    await assert.rejects(lib.verifyNativeBillingAccount(db, account.id, config, async () => {
      if (calls++ === 0) return response([], `/v2/projects/proj_test/customers/${account.id}/subscriptions?starting_after=last`)
      throw new Error('Interrupted pagination')
    }), { code: 'request' })
    assert.equal((await entitlement()).tier, 'premium')
    await lib.verifyNativeBillingAccount(db, account.id, config, async () => response([{ ...item, gives_access: false, status: 'expired' }]))
    assert.equal((await entitlement()).tier, 'free')
    await apply([subscription()])
  })
  await t.test('retiring a household leaves an unclaimable purchase identity', async () => {
    const closed = await lib.ensureNativeBillingAccount(db, retired, 'proj_test', 'production')
    await apply([subscription('retired_subscription', { originalCustomerId: closed.id })], closed)
    const started = await lib.beginNativeBillingVerification(db, closed.id)
    await db.query('delete from households where id=$1', [retired])
    await assert.rejects(lib.applyNativeBillingSnapshot(db, closed.id, started.revision, []), { code: 'account_retired' })
    await assert.rejects(lib.beginNativeBillingVerification(db, closed.id), { code: 'account_retired' })
    await assert.rejects(apply([subscription('retired_subscription', { originalCustomerId: otherAccount.id })], otherAccount), { code: 'purchase_already_bound' })
  })
  await t.test('store Premium households do not consume the free-household admission cap', async () => {
    process.env.FREE_HOUSEHOLD_CAP = '2' // one free household + one store subscriber + permanent owner
    const created = await lib.createHouseholdWithAdmission('new-parent', 'New household', 'Australia/Sydney')
    assert.ok(created.id)
    await assert.rejects(lib.createHouseholdWithAdmission('new-parent', 'Another household', 'Australia/Sydney'), error => error.status === 402)
  })
})
