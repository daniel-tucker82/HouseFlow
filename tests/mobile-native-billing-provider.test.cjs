/* eslint-disable @typescript-eslint/no-require-imports -- Provider transport fixtures never use live billing credentials. */
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), Module = require('node:module')
const { buildSync } = require('esbuild')
const filename = path.resolve(__dirname, '../lib/revenuecat-native-billing.ts'), loaded = new Module(filename, module)
loaded.paths = module.paths
loaded._compile(buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, filename)
const { revenueCatConfig, fetchVerifiedNativeSubscriptions } = loaded.exports
const account = { id: '5e298a41-d0bd-4df3-9d35-70cefb614cc1', household_id: 'household', project_id: 'proj_test', environment: 'production' }
const products = ['app_store', 'play_store'].flatMap(store => ['monthly', 'yearly'].map(interval => ({
  revenuecatProductId: `${store}_${interval}`, storeProductId: `cyntch.${store}.${interval}`, store, interval,
})))
const config = { projectId: account.project_id, environment: 'production', v2Secret: 'fixture-v2-secret', v1Secret: 'fixture-v1-secret', products }
const expiry = Date.parse('2027-01-04T00:00:00Z'), graceExpiry = Date.parse('2027-01-07T00:00:00Z')
function subscription(overrides = {}) {
  return { object: 'subscription', id: 'sub_apple', customer_id: account.id, original_customer_id: account.id, product_id: 'app_store_monthly',
    environment: 'production', store: 'app_store', ownership: 'purchased', gives_access: true, pending_payment: false,
    status: 'active', auto_renewal_status: 'will_renew', ends_at: expiry, current_period_ends_at: expiry, store_subscription_identifier: '1000000000123', ...overrides }
}
const page = (items, next_page = null) => ({ object: 'list', items, next_page })
function transport(responses) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), init })
    const response = responses.shift()
    assert.ok(response, 'unexpected provider request')
    if (response instanceof Error) throw response
    return response instanceof Response ? response : Response.json(response)
  }
  return { fetch, calls }
}
const verify = responses => fetchVerifiedNativeSubscriptions(account, config, transport(responses).fetch)

test('native billing config requires both stores and both intervals with no product aliasing', () => {
  assert.equal(revenueCatConfig({}), null)
  const env = { NATIVE_BILLING_ENABLED: 'true', REVENUECAT_PROJECT_ID: config.projectId, REVENUECAT_V1_SECRET_KEY: config.v1Secret,
    REVENUECAT_V2_SECRET_KEY: config.v2Secret, REVENUECAT_NATIVE_PRODUCTS: JSON.stringify(products) }
  assert.deepEqual(revenueCatConfig(env), config)
  for (const change of [{ REVENUECAT_PROJECT_ID: '' }, { REVENUECAT_V2_SECRET_KEY: undefined }, { REVENUECAT_NATIVE_PRODUCTS: '{' },
    { REVENUECAT_NATIVE_PRODUCTS: JSON.stringify(products.slice(1)) }, { REVENUECAT_NATIVE_PRODUCTS: JSON.stringify([...products.slice(0, 3), products[0]]) }]) {
    assert.throws(() => revenueCatConfig({ ...env, ...change }), { code: 'configuration' })
  }
})

test('all pages use authenticated uncached requests restricted to the same customer and environment', async () => {
  const io = transport([page([subscription()], `/v2/projects/${account.project_id}/customers/${account.id}/subscriptions?starting_after=sub_apple`),
    page([subscription({ id: 'sub_google', product_id: 'play_store_yearly', store: 'play_store' })])])
  const result = await fetchVerifiedNativeSubscriptions(account, config, io.fetch)
  assert.deepEqual(result.map(item => item.store), ['app_store', 'play_store'])
  assert.equal(result[0].accessThrough, '2027-01-04T00:00:00.000Z')
  for (const { url, init } of io.calls) {
    assert.equal(url.origin, 'https://api.revenuecat.com')
    assert.equal(url.searchParams.get('environment'), 'production')
    assert.equal(init.headers.Authorization, 'Bearer fixture-v2-secret')
    assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal)
  }
})

test('cancellation, renewal and pending payments follow the verified access decision without inventing expiry', async () => {
  for (const change of [{ auto_renewal_status: 'will_not_renew' }, { pending_payment: true }, { status: 'unknown' }]) {
    const result = (await verify([page([subscription(change)])]))[0]
    assert.equal(result.givesAccess, true); assert.equal(result.pendingPayment, change.pending_payment ?? false)
  }
  for (const status of ['expired', 'incomplete', 'in_billing_retry', 'paused']) {
    const [result] = await verify([page([subscription({ status, gives_access: false, ends_at: null, current_period_ends_at: null })])])
    assert.equal(result.givesAccess, false); assert.equal(result.accessThrough, null)
  }
  const [renewed] = await verify([page([subscription({ auto_renewal_status: 'has_already_renewed', ends_at: graceExpiry })])])
  assert.equal(renewed.accessThrough, '2027-01-07T00:00:00.000Z')
  await assert.rejects(verify([page([subscription({ ends_at: null, current_period_ends_at: null })])]), { code: 'response' })
})

test('grace access requires matching V1 ownership, store, transaction, environment and explicit grace expiry', async () => {
  const legacySubscription = { store: 'app_store', is_sandbox: false, store_transaction_id: '1000000000123', refunded_at: null,
    grace_period_expires_date: new Date(graceExpiry).toISOString() }
  function legacy(overrides = {}, id = account.id) { return { subscriber: { original_app_user_id: id, subscriptions: { 'cyntch.app_store.monthly': { ...legacySubscription, ...overrides } } } } }
  const io = transport([page([subscription({ status: 'in_grace_period' })]), legacy()])
  const [result] = await fetchVerifiedNativeSubscriptions(account, config, io.fetch)
  assert.equal(result.accessThrough, '2027-01-07T00:00:00.000Z')
  assert.equal(io.calls[1].init.headers.Authorization, 'Bearer fixture-v1-secret')
  for (const change of [{ is_sandbox: true }, { store: 'play_store' }, { store_transaction_id: 'other' }, { refunded_at: '2027-01-01T00:00:00Z' },
    { grace_period_expires_date: null }, { grace_period_expires_date: 'invalid' }]) {
    await assert.rejects(verify([page([subscription({ status: 'in_grace_period' })]), legacy(change)]), { code: 'response' })
  }
  await assert.rejects(verify([page([subscription({ status: 'in_grace_period' })]), legacy({}, 'other')]), { code: 'identity' })
})

test('transfers, aliases, family-shared purchases, wrong environments and malformed snapshots cannot become household grants', async () => {
  for (const change of [{ original_customer_id: 'different-household' }, { customer_id: 'different-household' }]) {
    await assert.rejects(verify([page([subscription(change)])]), { code: 'identity' })
  }
  for (const change of [{ ownership: 'family_shared' }, { environment: 'sandbox' }, { gives_access: 'true' }, { ends_at: '2099-01-01' },
    { ends_at: 9_000_000_000_000_000 }, { pending_payment: undefined }, { store: 'play_store' }, { status: null }]) {
    await assert.rejects(verify([page([subscription(change)])]), { code: 'response' })
  }
  await assert.rejects(verify([page([subscription(), subscription()])]), { code: 'response' })
  assert.deepEqual(await verify([page([subscription({ product_id: 'unapproved_product' })])]), [])
  assert.deepEqual(await verify([page([])]), [])
})

test('partial pagination, redirects, another customer URL and pagination loops fail without exposing credentials', async () => {
  const base = `/v2/projects/${account.project_id}/customers/${account.id}/subscriptions`
  for (const next of ['https://example.test/collect', 'https://api.revenuecat.com@evil.example/subscriptions', '/v2/projects/other/customers/other/subscriptions',
    `${base}?access_token=anything`, `${base}#fragment`, base]) {
    const io = transport([page([subscription()], next)])
    await assert.rejects(fetchVerifiedNativeSubscriptions(account, config, io.fetch), { code: 'pagination' })
    assert.equal(io.calls.length, 1, 'never forward credentials to the next untrusted URL')
  }
  await assert.rejects(verify([page([subscription()], `${base}?starting_after=sub_apple`), new Error('network failed')]), { code: 'request' })
  await assert.rejects(verify([new Response('fixture-secret-must-not-leak', { status: 429 })]), error => error.code === 'request' && error.providerStatus === 429 && !error.message.includes('fixture-secret'))
  await assert.rejects(verify([new Response('not json', { status: 200 })]), { code: 'response' })
})
