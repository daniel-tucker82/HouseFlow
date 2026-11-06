const { test } = require('node:test')
const assert = require('node:assert/strict')
const { safetyFixture, validateAttestation, resumeAcceptedTerms } = require('./native-safety-smoke.cjs')
const { requireOwnedHost } = require('../../.github/scripts/ios-device-network.cjs')
const configured = { CYNTCH_NATIVE_SAFETY_CHECK: 'true', CYNTCH_NATIVE_TEST_EMAIL: 'cyntch-native-20261103+clerk_test@example.com',
  EXPO_PUBLIC_API_URL: 'https://isolated-test.ngrok-free.app', EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_ZW1lcmdpbmctdG9hZC05OC5jbGVyay5hY2NvdW50cy5kZXYk' }
test('safety verification cannot mix ordinary, deletion or offline-task journeys', () => {
  assert.equal(safetyFixture(configured).origin, configured.EXPO_PUBLIC_API_URL)
  for (const patch of [{ CYNTCH_NATIVE_SAFETY_CHECK: '' }, { CYNTCH_NATIVE_TEST_EMAIL: 'cyntch-native-other+clerk_test@example.com' },
    { CYNTCH_NATIVE_HOUSEHOLD_CHECK: 'true' }, { CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK: 'true' }, { CYNTCH_ANDROID_OFFLINE: 'true' }]) {
    assert.throws(() => safetyFixture({ ...configured, ...patch }))
  }
})
test('private fixture attestation prevents replaying saved acceptance or reports and requires preservation', () => {
  const source = 'a'.repeat(40), before = { scope: 'cyntch-private-safety-verification', platform: 'android', source,
    schema: 'native_safety_' + 'b'.repeat(32), originalPreserved: true, termsVersion: '2026-11-06.1', termsAcceptances: 0, reports: 0 }
  assert.deepEqual(validateAttestation(before, 'android', source), before)
  for (const patch of [{ platform: 'ios' }, { schema: 'public' }, { source: 'c'.repeat(40) }, { originalPreserved: false },
    { termsAcceptances: 1 }, { reports: 1 }, { termsVersion: '2020-01-01.1' }]) assert.throws(() => validateAttestation({ ...before, ...patch }, 'android', source))
  const after = { ...before, termsAcceptances: 1, reports: 1, expectedReportMatches: true }
  assert.deepEqual(validateAttestation(after, 'android', source, true), after)
  assert.throws(() => validateAttestation({ ...after, reports: 2 }, 'android', source, true))
  assert.throws(() => validateAttestation({ ...after, expectedReportMatches: false }, 'android', source, true))
})
test('network outage for reporting requires both explicit safety scope and a disposable hosted runner', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ID: '123',
    CYNTCH_IOS_REPLAY_SCOPE: 'safety', CYNTCH_NATIVE_SAFETY_CHECK: 'true' }
  assert.doesNotThrow(() => requireOwnedHost(env, 'darwin'))
  for (const patch of [{ CYNTCH_NATIVE_SAFETY_CHECK: '' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { CYNTCH_IOS_REPLAY_SCOPE: '' }]) {
    assert.throws(() => requireOwnedHost({ ...env, ...patch }, 'darwin'))
  }
  assert.throws(() => requireOwnedHost(env, 'win32'))
})

test('accepted terms can resume only the inspected Android producer, never a submitted report', () => {
  const env = { CYNTCH_NATIVE_SAFETY_RESUME_TERMS: 'true', CYNTCH_ANDROID_APK_PRODUCER: '42177470430' }
  assert.equal(resumeAcceptedTerms({}, 'linux'), false)
  assert.equal(resumeAcceptedTerms(env, 'linux'), true)
  assert.throws(() => resumeAcceptedTerms(env, 'darwin'))
  assert.throws(() => resumeAcceptedTerms({ ...env, CYNTCH_ANDROID_APK_PRODUCER: '123' }, 'linux'))
  const source = 'a'.repeat(40), before = { scope: 'cyntch-private-safety-verification', platform: 'android', source,
    schema: 'native_safety_' + 'b'.repeat(32), originalPreserved: true, termsVersion: '2026-11-06.1', termsAcceptances: 1, reports: 0 }
  assert.deepEqual(validateAttestation(before, 'android', source, false, true), before)
  assert.throws(() => validateAttestation({ ...before, reports: 1 }, 'android', source, false, true))
  assert.throws(() => validateAttestation({ ...before, termsAcceptances: 0 }, 'android', source, false, true))
})
