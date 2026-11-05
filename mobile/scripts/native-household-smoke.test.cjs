const { test } = require('node:test')
const assert = require('node:assert/strict')
const { householdFixture, householdSection } = require('./native-household-smoke.cjs')

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

test('partial household replay excludes destructive submission and rejects unknown sections', () => {
  const env = { CYNTCH_NATIVE_HOUSEHOLD_CHECK: 'true', CYNTCH_NATIVE_TEST_EMAIL: 'cyntch-native-20261103+clerk_test@example.com',
    EXPO_PUBLIC_API_URL: 'https://owned-test.ngrok-free.app',
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_ZW1lcmdpbmctdG9hZC05OC5jbGVyay5hY2NvdW50cy5kZXYk' }
  assert.equal(householdSection(env), 'all')
  assert.equal(householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_SECTION: 'invitations-and-review' }), 'invitations-and-review')
  assert.equal(householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_SECTION: 'resume-invitation:012345abcdef' }), 'resume-invitation:012345abcdef')
  for (const section of ['resume-invitation:', 'resume-invitation:not-a-code', 'resume-invitation:012345abcdef0']) assert.throws(() => householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_SECTION: section }))
  assert.throws(() => householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_SECTION: 'resume-invitation:012345abcdef', CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK: 'true' }))
  assert.throws(() => householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_SECTION: 'invitations-and-review', CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK: 'true' }))
  assert.throws(() => householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_SECTION: 'unknown' }))
  assert.throws(() => householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_CHECK: '' }))
  assert.equal(householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_RESUME_MEMBER: 'true', CYNTCH_IOS_REPLAY_SCOPE: 'household-resume-member' }), 'all')
  assert.throws(() => householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_RESUME_MEMBER: 'true' }))
  assert.throws(() => householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_RESUME_MEMBER: 'true', CYNTCH_IOS_REPLAY_SCOPE: 'household-resume-member', CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK: 'true' }))
  assert.throws(() => householdSection({ ...env, CYNTCH_NATIVE_HOUSEHOLD_RESUME_MEMBER: 'true', CYNTCH_IOS_REPLAY_SCOPE: 'household-resume-member', CYNTCH_NATIVE_HOUSEHOLD_SECTION: 'invitations-and-review' }))
  const colour = { ...env, CYNTCH_NATIVE_HOUSEHOLD_RESUME_COLOUR: 'true', CYNTCH_IOS_REPLAY_SCOPE: 'household-resume-colour' }
  assert.equal(householdSection(colour), 'all')
  for (const override of [{ CYNTCH_IOS_REPLAY_SCOPE: '' }, { CYNTCH_IOS_REPLAY_SCOPE: 'household-resume-member' },
    { CYNTCH_NATIVE_HOUSEHOLD_RESUME_MEMBER: 'true' }, { CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK: 'true' },
    { CYNTCH_NATIVE_HOUSEHOLD_SECTION: 'invitations-and-review' }]) assert.throws(() => householdSection({ ...colour, ...override }))
})
