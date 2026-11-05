const { test } = require('node:test')
const assert = require('node:assert/strict')
const { deletionFixture } = require('./native-account-deletion-smoke.cjs')

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
