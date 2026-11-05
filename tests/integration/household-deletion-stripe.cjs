/* eslint-disable @typescript-eslint/no-require-imports -- Explicit, isolated test-mode provider verification. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process')
const { fixture } = require('../helpers/account-deletion.cjs')

test('standalone household deletion cancels its actual test subscription and recovers a lost response without touching another household', {
  skip: process.env.CYNTCH_STRIPE_SANDBOX_TEST !== 'true', timeout: 180000,
}, async t => {
  const cli = process.env.CYNTCH_STRIPE_CLI, expectedAccount = process.env.CYNTCH_STRIPE_EXPECTED_ACCOUNT
  assert.ok(cli && path.isAbsolute(cli), 'Use an explicit current Stripe CLI path')
  assert.match(expectedAccount ?? '', /^acct_[A-Za-z0-9]+$/, 'Select the isolated test account explicitly')
  function command(args, timeout = 12000) {
    const result = cp.spawnSync(cli, args, { encoding: 'utf8', windowsHide: true, timeout })
    if (result.error) throw Error('Stripe test request interrupted')
    let value; try { value = JSON.parse(result.stdout) } catch { throw Error('Stripe test request returned invalid JSON') }
    if (result.status !== 0 || value.error) throw Error(`Stripe test request failed: ${value.error?.type ?? 'exit'}/${value.error?.code ?? 'unknown'}`)
    return value
  }
  const identity = command(['whoami', '--format', 'json'])
  assert.equal(identity.mode, 'test'); assert.equal(identity.authorized, true); assert.equal(identity.account_id, expectedAccount)
  const fields = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) => {
    const name = prefix ? `${prefix}[${key}]` : key
    return item && typeof item === 'object' ? fields(item, name) : [`${name}=${item}`]
  })
  function api(method, resource, data = {}, timeout) {
    const value = command([method, resource, '--color', 'off', '--stripe-version', '2026-10-28.endive',
      ...fields(data).flatMap(field => ['-d', field]), ...(['post', 'delete'].includes(method) ? ['--confirm'] : [])], timeout)
    if ('livemode' in value) assert.equal(value.livemode, false)
    return value
  }
  assert.equal(api('get', '/v1/balance').livemode, false)
  const run = randomUUID(), file = path.join(os.tmpdir(), `cyntch-household-deletion-stripe-${run}.json`)
  const evidence = { run, account: expectedAccount, mode: 'test', transport: 'existing authenticated Stripe CLI',
    customers: [], price: null, product: null, verified: false, cleaned: false }
  const save = () => fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
  save()
  t.after(() => {
    for (const id of evidence.customers) {
      const customer = api('get', `/v1/customers/${id}`)
      if (!customer.deleted) { assert.equal(customer.metadata.test_run, run); api('delete', `/v1/customers/${id}`) }
    }
    if (evidence.price) api('post', `/v1/prices/${evidence.price}`, { active: false })
    if (evidence.product) api('post', `/v1/products/${evidence.product}`, { active: false })
    evidence.cleaned = true; save(); console.log('Household deletion sandbox evidence:', file)
  })
  const f = await fixture(t), lib = f.load(['lib/household-deletion.ts', 'lib/household-deletion-processing.ts'])
  evidence.product = api('post', '/v1/products', { name: `Cyntch household deletion ${run}`, metadata: { test_run: run } }).id; save()
  // Zero-priced subscriptions verify cancellation without charging a card.
  evidence.price = api('post', '/v1/prices', { product: evidence.product, currency: 'aud', unit_amount: 0, recurring: { interval: 'month' } }).id; save()
  const bindings = []
  for (const householdId of [f.deleting, f.transfer]) {
    const metadata = { app: 'cyntch', household_id: householdId, test_run: run }
    const customer = api('post', '/v1/customers', { metadata }); evidence.customers.push(customer.id); save()
    const subscription = api('post', '/v1/subscriptions', { customer: customer.id, items: [{ price: evidence.price }], metadata })
    assert.equal(subscription.status, 'active')
    await f.db.query('update household_billing set stripe_customer_id=$2,stripe_subscription_id=$3 where household_id=$1', [householdId, customer.id, subscription.id])
    bindings.push({ householdId, customer: customer.id, subscription: subscription.id })
  }
  const [deleting, kept] = bindings
  const preservedBefore = (await f.db.query('select * from household_billing where household_id=$1', [kept.householdId])).rows[0]
  const receipt = await lib.acceptHouseholdDeletion(f.db, f.owner, deleting.householdId, true, {
    HOUSEHOLD_DELETION_SUBMISSION_ENABLED: 'true', HOUSEHOLD_DELETION_PROCESSING_ENABLED: 'true', STRIPE_SECRET_KEY: 'rk_test_fixture',
  })
  assert.equal(receipt.state, 'pending')
  assert.equal((await f.db.query('select count(*)::int n from households where id=$1', [deleting.householdId])).rows[0].n, 0)
  const job = async () => (await f.db.query('select * from household_deletion_requests where id=$1', [receipt.id])).rows[0]
  assert.equal((await job()).stripe_customer_id, deleting.customer)
  let deleteCalls = 0
  const provider = { livemode: false, client: { customers: {
    retrieve: async (id, params, options) => { assert.equal(id, deleting.customer); return api('get', `/v1/customers/${id}`, {}, Math.floor(options.timeout)) },
    del: async (id, params, options) => {
      assert.equal(id, deleting.customer); assert.equal(deleteCalls++, 0, 'The provider DELETE must not repeat after response loss')
      const customer = api('get', `/v1/customers/${id}`); assert.equal(customer.metadata.test_run, run)
      assert.equal(api('delete', `/v1/customers/${id}`, {}, Math.floor(options.timeout)).deleted, true)
      throw Error('Lost acknowledgement after actual test customer deletion')
    },
  } } }
  assert.deepEqual(await lib.processHouseholdDeletions(f.db, provider), { completed: 0, retried: 1 })
  assert.equal((await job()).state, 'pending'); assert.equal((await job()).stripe_customer_id, deleting.customer)
  assert.equal(api('get', `/v1/subscriptions/${deleting.subscription}`).status, 'canceled')
  await f.db.query('update household_deletion_requests set next_attempt_at=now() where id=$1', [receipt.id])
  assert.deepEqual(await lib.processHouseholdDeletions(f.db, provider), { completed: 1, retried: 0 })
  const done = await job()
  assert.equal(deleteCalls, 1); assert.equal(done.state, 'completed'); assert.equal(done.stripe_customer_id, null)
  assert.equal(done.stripe_subscription_id, null); assert.equal(done.stripe_livemode, null)
  assert.equal(api('get', `/v1/customers/${deleting.customer}`).deleted, true)
  assert.equal(api('get', `/v1/customers/${kept.customer}`).metadata.test_run, run)
  assert.equal(api('get', `/v1/subscriptions/${kept.subscription}`).status, 'active')
  assert.deepEqual((await f.db.query('select * from household_billing where household_id=$1', [kept.householdId])).rows[0], preservedBefore)
  assert.equal((await f.db.query('select count(*)::int n from users where id=$1', [f.owner])).rows[0].n, 1)
  evidence.verified = true; evidence.subscriptionCancelled = true; evidence.lostResponseRecovered = true
  evidence.providerDeleteCalls = deleteCalls; evidence.accountAndOtherHouseholdPreserved = true; save()
})
