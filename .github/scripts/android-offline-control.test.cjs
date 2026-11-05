const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')

function harness({ failFlow, survivingPid = '', avd = 'cyntch-phone' } = {}) {
  const calls = [], radios = { wifi: '1', data: '1' }, flows = []
  const fakeFs = { mkdirSync() {}, openSync: () => 9, closeSync() {}, writeFileSync() {} }
  const sandbox = { module: { exports: {} }, process: { platform: 'linux', env: { GITHUB_ACTIONS: 'true', GITHUB_SHA: 'a'.repeat(40) } },
    require: name => {
      if (name === 'node:fs') return fakeFs
      if (name === 'node:path') return path
      if (name === './native-auth-smoke.cjs') return { authFixture: () => ({}) }
      if (name === './device-screenshot-evidence.cjs') return { inspectScreenshotOrientations: () => ({ passed: true }) }
      assert.equal(name, 'node:child_process')
      return {
        execFileSync: (_command, args) => {
          calls.push(args)
          const rest = args.slice(2)
          if (rest.join(' ') === 'shell getprop ro.kernel.qemu') return '1'
          if (rest.join(' ') === 'emu avd name') return avd + '\nOK'
          if (rest[1] === 'settings') return radios[rest[4] === 'wifi_on' ? 'wifi' : 'data']
          if (rest[1] === 'svc') { radios[rest[2]] = rest[3] === 'enable' ? '1' : '0'; return '' }
          assert.equal(rest.join(' '), 'shell am force-stop com.cyntch.app')
          return ''
        },
        spawnSync: (command, args) => {
          if (command === 'adb') return { status: survivingPid ? 0 : 1, stdout: survivingPid }
          const flow = path.basename(args.at(-1), '.yaml'); flows.push(flow)
          return { status: flow === failFlow ? 1 : 0 }
        },
      }
    } }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../mobile/scripts/android-offline-smoke.cjs'), 'utf8'), sandbox)
  return { calls, radios, flows, run: () => sandbox.module.exports.runOfflineSmoke({ maestro: 'maestro', device: 'emulator-5554', output: '/owned-fixture', orientations: { portrait: 'PORTRAIT' } }) }
}
test('an interrupted offline journey stays failed and restores both emulator radios', () => {
  const h = harness({ failFlow: 'complete' }), result = h.run()
  assert.equal(result.passed, false); assert.match(result.error, /complete flow failed/)
  assert.deepEqual(h.radios, { wifi: '1', data: '1' })
  assert.deepEqual(h.flows, ['prepare', 'complete'])
  assert.equal(result.processStopped, undefined)
})
test('a surviving process cannot be labelled an offline cold-start pass', () => {
  const h = harness({ survivingPid: '1234' }), result = h.run()
  assert.equal(result.passed, false); assert.match(result.error, /still has a process/)
  assert.deepEqual(h.flows, ['prepare', 'complete']); assert.equal(result.survivedOfflineRestart, undefined)
  assert.deepEqual(h.radios, { wifi: '1', data: '1' })
})
test('only the owned emulator is allowed to change network settings', () => {
  const h = harness({ avd: 'personal-phone' })
  assert.throws(h.run, /owned phone/)
  assert.equal(h.calls.some(args => args.includes('svc')), false)
})

test('failed online task preparation never disables network access', () => {
  const h = harness({ failFlow: 'prepare' }), result = h.run()
  assert.equal(result.passed, false); assert.match(result.error, /prepare flow failed/)
  assert.equal(h.calls.some(args => args.includes('svc')), false)
  assert.deepEqual(h.flows, ['prepare'])
  assert.deepEqual(h.radios, { wifi: '1', data: '1' })
})
test('successful control sequence requires all phases and preserves radio settings', () => {
  const h = harness(), result = h.run()
  assert.equal(result.passed, true)
  assert.deepEqual(h.flows, ['prepare', 'complete', 'restart', 'reconnect'])
  assert.deepEqual(h.radios, { wifi: '1', data: '1' })
  assert.equal(result.processStopped, true)
  assert.equal(result.synchronizedAndReopened, true)
})
