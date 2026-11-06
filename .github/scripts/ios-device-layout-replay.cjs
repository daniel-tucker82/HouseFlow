// Replays only the signed-out layout cases missing from inspected evidence.
// These plans cannot authenticate, submit edits or repeat passed font cases.
const plans = {
  'layout-current-iphone': { family: 'iphone', runtime: '', contentSizes: ['large', 'accessibility-extra-large'] },
  'layout-minimum-iphone-default': { family: 'iphone', runtime: '17.0', contentSizes: ['large'] },
  'layout-current-ipad-large': { family: 'ipad', runtime: '', contentSizes: ['accessibility-extra-large'] },
  'layout-minimum-ipad': { family: 'ipad', runtime: '17.0', contentSizes: ['large', 'accessibility-extra-large'] },
}

function layoutReplay(scope, env = process.env) {
  if (!scope?.startsWith('layout-')) return null
  const plan = plans[scope]
  if (!plan) throw new Error('Unknown signed-out layout replay.')
  if (env.CYNTCH_IOS_TEST_FAMILY !== plan.family || (env.CYNTCH_IOS_TEST_RUNTIME || '') !== plan.runtime) {
    throw new Error('Layout replay does not match its inspected device and runtime.')
  }
  if (env.EXPO_PUBLIC_API_URL !== 'https://cyntch-simulator.invalid' || env.CYNTCH_NATIVE_TEST_EMAIL
      || env.CYNTCH_NATIVE_HOUSEHOLD_CHECK === 'true' || env.CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK === 'true') {
    throw new Error('Layout replay must stay signed out with no connected household.')
  }
  return { ...plan, contentSizes: [...plan.contentSizes] }
}

module.exports = { layoutReplay }
