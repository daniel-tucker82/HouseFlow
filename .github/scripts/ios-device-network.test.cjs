const { test } = require('node:test')
const assert = require('node:assert/strict')
const { requireOwnedHost, networkInterface, restoreDecision } = require('./ios-device-network.cjs')
test('network interruption rejects local machines, self-hosted runners and unrelated jobs', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', CYNTCH_IOS_REPLAY_SCOPE: 'offline', GITHUB_RUN_ID: '1234' }
  assert.doesNotThrow(() => requireOwnedHost(env, 'darwin'))
  for (const override of [{ GITHUB_ACTIONS: '' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { CYNTCH_IOS_REPLAY_SCOPE: 'current-devices' }, { GITHUB_RUN_ID: '' }]) assert.throws(() => requireOwnedHost({ ...env, ...override }, 'darwin'))
  assert.throws(() => requireOwnedHost(env, 'win32'))
})
test('only a previously enabled Ethernet interface matching the default route can be restored', () => {
  const route = '   route to: default\n  interface: en0\n'
  assert.equal(networkInterface(route, 'en0: flags=8863<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500'), 'en0')
  for (const config of ['en1: flags=1<UP,RUNNING>', 'en0: flags=0<BROADCAST,RUNNING>', 'en0: flags=0<UP>']) assert.throws(() => networkInterface(route, config))
  assert.throws(() => networkInterface('interface: lo0', 'lo0: flags=1<UP,RUNNING>'))
})
test('independent restoration handles success, abrupt parent exit and a hung parent', () => {
  assert.equal(restoreDecision({ requested: false, ownerAlive: true, now: 10, until: 20 }), null)
  assert.equal(restoreDecision({ requested: true, ownerAlive: true, now: 10, until: 20 }), 'requested')
  assert.equal(restoreDecision({ requested: false, ownerAlive: false, now: 10, until: 20 }), 'owner-exited')
  assert.equal(restoreDecision({ requested: false, ownerAlive: true, now: 20, until: 20 }), 'deadline')
})
