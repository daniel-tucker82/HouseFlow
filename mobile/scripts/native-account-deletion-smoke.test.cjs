const { test } = require('node:test')
const assert = require('node:assert/strict')
const { deletionFixture, verifyAccountDeletionBackend } = require('./native-account-deletion-smoke.cjs')

test('native deletion cannot use the ordinary household fixture, another provider or an implicit run', () => {
  const fixture = {
    CYNTCH_IOS_REPLAY_SCOPE: 'account-deletion',
    CYNTCH_NATIVE_TEST_EMAIL: 'cyntch-native-delete-65ddbe2042c9465ab63de45600fb4907+clerk_test@example.com',
    EXPO_PUBLIC_API_URL: 'https://owned-test.ngrok-free.app',
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_ZW1lcmdpbmctdG9hZC05OC5jbGVyay5hY2NvdW50cy5kZXYk',
  }
  assert.deepEqual(deletionFixture(fixture), {email:fixture.CYNTCH_NATIVE_TEST_EMAIL,origin:fixture.EXPO_PUBLIC_API_URL})
  for (const override of [
    {CYNTCH_NATIVE_TEST_EMAIL:'cyntch-native-parent+clerk_test@example.com'},
    {CYNTCH_NATIVE_TEST_EMAIL:'cyntch-native-delete+clerk_test@example.com'},
    {CYNTCH_NATIVE_TEST_EMAIL:fixture.CYNTCH_NATIVE_TEST_EMAIL.replace('+clerk_test','')},
    {CYNTCH_IOS_REPLAY_SCOPE:'notifications'}, {CYNTCH_IOS_REPLAY_SCOPE:''},
    {EXPO_PUBLIC_API_URL:'https://www.cyntch.com'}, {EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY:'pk_live_wrong'},
  ]) assert.throws(() => deletionFixture({...fixture,...override}))
})

test('account deletion requires a fresh unused fixture, normal child profile and an available bounded worker', async () => {
  const nonce = '84501a1d-a7c4-4ca1-b0f0-61c8cf6ede4b'
  const email = `cyntch-native-delete-${nonce.replaceAll('-', '')}+clerk_test@example.com`
  const env = { CYNTCH_IOS_REPLAY_SCOPE: 'account-deletion', CYNTCH_NATIVE_TEST_EMAIL: email,
    EXPO_PUBLIC_API_URL: 'https://owned-test.ngrok-free.app',
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_ZW1lcmdpbmctdG9hZC05OC5jbGVyay5hY2NvdW50cy5kZXYk' }
  const now = Date.parse('2026-11-05T12:00:00Z')
  const ready = { nonce, email, schema: 'native_delete_' + nonce.replaceAll('-', ''), accountId: 'user_test',
    householdId: '1d2bd69a-f73f-403e-a243-0960d3fe169e', childProfileId: 'local_member_46aa18f3-c62e-4b81-9261-7b016e52e8dc',
    privateSchema: true, providerMarkerVerified: true, providerSelfDeletionDisabled: true, householdPresent: true,
    childProfilePresent: true, requestCount: 0, originalHouseholdProtected: true, providerInventoryReady: true,
    workerRunning: true, checkedAt: new Date(now).toISOString(), workerUntil: new Date(now + 30 * 60 * 1000).toISOString() }
  const fetcher = async (url, options) => {
    assert.equal(url.href, env.EXPO_PUBLIC_API_URL + '/__cyntch-native-account-deletion-fixture')
    assert.equal(options.headers['X-Cyntch-Verification'], nonce)
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store')
    return { ok: true, json: async () => ready }
  }
  assert.deepEqual(await verifyAccountDeletionBackend(env, fetcher, now), ready)
  for (const override of [
    { nonce: 'old-fixture' }, { email: email.replace('84501a1d', '84501a1e') }, { schema: 'public' },
    { accountId: null }, { householdId: null }, { childProfileId: 'native-delete-child-' + nonce },
    { requestCount: 1 }, { requestCount: '0' }, { privateSchema: false }, { providerMarkerVerified: false },
    { providerSelfDeletionDisabled: false }, { householdPresent: false }, { childProfilePresent: false },
    { originalHouseholdProtected: false }, { providerInventoryReady: false }, { workerRunning: false },
    { checkedAt: new Date(now - 31000).toISOString() }, { checkedAt: new Date(now + 6000).toISOString() },
    { checkedAt: null }, { workerUntil: null }, { workerUntil: new Date(now + 14 * 60 * 1000).toISOString() },
  ]) await assert.rejects(verifyAccountDeletionBackend(env, async () => ({ ok: true, json: async () => ({ ...ready, ...override }) }), now))
  await assert.rejects(verifyAccountDeletionBackend(env, async () => ({ ok: false }), now))
  await assert.rejects(verifyAccountDeletionBackend(env, async () => { throw new Error('offline') }, now))
})
