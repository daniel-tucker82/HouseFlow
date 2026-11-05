const { test } = require('node:test'), assert = require('node:assert/strict')
const { expected, verifyHouseholdDeletionBackend } = require('./native-household-deletion-smoke.cjs')
const env = { CYNTCH_NATIVE_HOUSEHOLD_CHECK: 'true', CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK: 'true',
  CYNTCH_NATIVE_TEST_EMAIL: 'cyntch-native-20261103+clerk_test@example.com', EXPO_PUBLIC_API_URL: 'https://owned-test.ngrok-free.app',
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_ZW1lcmdpbmctdG9hZC05OC5jbGVyay5hY2NvdW50cy5kZXYk' }
const ready = { ...expected, householdPresent: true, keptHouseholdPresent: true, requestCount: 0,
  originalHouseholdProtected: true, privateSchema: true, providerMutationsEnabled: false, accountDeletionEnabled: false }

test('destructive household verification requires explicit mode and a fresh isolated backend attestation', async () => {
  let reads = 0
  const fetcher = async (url, options) => {
    reads++; assert.equal(url.origin, env.EXPO_PUBLIC_API_URL); assert.equal(url.pathname, '/__cyntch-native-household-deletion-fixture')
    assert.equal(options.headers['X-Cyntch-Verification'], expected.nonce); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store')
    return Response.json(ready)
  }
  for (const override of [{ CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK: '' }, { CYNTCH_NATIVE_HOUSEHOLD_CHECK: '' },
    { CYNTCH_NATIVE_TEST_EMAIL: 'cyntch-native-delete-123+clerk_test@example.com' }, { EXPO_PUBLIC_API_URL: 'https://www.cyntch.com' }]) {
    await assert.rejects(verifyHouseholdDeletionBackend({ ...env, ...override }, fetcher))
  }
  assert.equal(reads, 0); assert.deepEqual(await verifyHouseholdDeletionBackend(env, fetcher), ready); assert.equal(reads, 1)
})

test('ordinary, changed, already-submitted or provider-enabled fixtures cannot start another deletion', async () => {
  for (const wrong of [{ nonce: 'another' }, { householdId: '01107d49-1161-45d2-a3b8-ab1d0c682d69' },
    { keptHouseholdId: expected.householdId }, { accountId: 'another' }, { schema: 'public' }, { householdPresent: false },
    { keptHouseholdPresent: false }, { requestCount: 1 }, { originalHouseholdProtected: false }, { privateSchema: false },
    { providerMutationsEnabled: true }, { accountDeletionEnabled: true }]) {
    await assert.rejects(verifyHouseholdDeletionBackend(env, async () => Response.json({ ...ready, ...wrong })))
  }
  await assert.rejects(verifyHouseholdDeletionBackend(env, async () => new Response('', { status: 404 })))
})
