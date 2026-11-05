const { test } = require('node:test')
const assert = require('node:assert/strict')
const { householdFixture } = require('./native-household-smoke.cjs')

test('member mutation verification requires the explicit ordinary fixture, excluding deletion accounts and production', () => {
  const env = { CYNTCH_NATIVE_HOUSEHOLD_CHECK: 'true', CYNTCH_NATIVE_TEST_EMAIL: 'cyntch-native-20261103+clerk_test@example.com',
    EXPO_PUBLIC_API_URL: 'https://owned-test.ngrok-free.app',
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_ZW1lcmdpbmctdG9hZC05OC5jbGVyay5hY2NvdW50cy5kZXYk' }
  assert.equal(householdFixture(env).email, env.CYNTCH_NATIVE_TEST_EMAIL)
  for (const override of [{ CYNTCH_NATIVE_HOUSEHOLD_CHECK: '' }, { CYNTCH_NATIVE_TEST_EMAIL: 'cyntch-native-delete-65ddbe2042c9465ab63de45600fb4907+clerk_test@example.com' },
    { CYNTCH_NATIVE_TEST_EMAIL: 'cyntch-native-other+clerk_test@example.com' }, { EXPO_PUBLIC_API_URL: 'https://www.cyntch.com' }, { EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_wrong' }]) {
    assert.throws(() => householdFixture({ ...env, ...override }))
  }
})
