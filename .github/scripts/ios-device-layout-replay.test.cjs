const { test } = require('node:test')
const assert = require('node:assert/strict')
const { layoutReplay } = require('./ios-device-layout-replay.cjs')
const base = { EXPO_PUBLIC_API_URL: 'https://cyntch-simulator.invalid', CYNTCH_IOS_TEST_FAMILY: 'iphone' }

test('only failed or unstarted layout cases are selected', () => {
  assert.deepEqual(layoutReplay('layout-current-iphone', base).contentSizes, ['large', 'accessibility-extra-large'])
  assert.deepEqual(layoutReplay('layout-minimum-iphone-default', { ...base, CYNTCH_IOS_TEST_RUNTIME: '17.0' }).contentSizes, ['large'])
  assert.deepEqual(layoutReplay('layout-current-ipad-large', { ...base, CYNTCH_IOS_TEST_FAMILY: 'ipad' }).contentSizes, ['accessibility-extra-large'])
  assert.equal(layoutReplay('offline', base), null)
})

test('mismatched or connected journeys cannot use signed-out layout replay', () => {
  assert.throws(() => layoutReplay('layout-unknown', base), /Unknown/)
  for (const extra of [
    { CYNTCH_IOS_TEST_FAMILY: 'ipad' }, { CYNTCH_IOS_TEST_RUNTIME: '17.0' },
    { EXPO_PUBLIC_API_URL: 'https://example.com' }, { CYNTCH_NATIVE_TEST_EMAIL: 'reserved@example.invalid' },
    { CYNTCH_NATIVE_HOUSEHOLD_CHECK: 'true' }, { CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK: 'true' },
  ]) assert.throws(() => layoutReplay('layout-current-iphone', { ...base, ...extra }))
})
