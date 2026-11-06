const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { authFixture } = require('./native-auth-smoke.cjs')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')
const { runIOSUI } = require('../../.github/scripts/ios-device-process.cjs')
const network = require('../../.github/scripts/ios-device-network.cjs')

function safetyFixture(env = process.env) {
  const fixture = authFixture(env)
  if (env.CYNTCH_NATIVE_SAFETY_CHECK !== 'true' || fixture?.email !== 'cyntch-native-20261103+clerk_test@example.com' ||
      env.CYNTCH_NATIVE_HOUSEHOLD_CHECK === 'true' || env.CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK === 'true' || env.CYNTCH_ANDROID_OFFLINE === 'true') {
    throw new Error('Select only the isolated safety-report and terms journey.')
  }
  return fixture
}
function validateAttestation(value, platform, source, final = false) {
  assert.equal(value.scope, 'cyntch-private-safety-verification')
  assert.equal(value.platform, platform); assert.equal(value.source, source)
  assert.match(value.schema, /^native_safety_[a-f0-9]{32}$/)
  assert.equal(value.originalPreserved, true); assert.equal(value.termsVersion, '2026-11-06.1')
  assert.equal(value.termsAcceptances, final ? 1 : 0)
  assert.equal(value.reports, final ? 1 : 0)
  if (final) assert.equal(value.expectedReportMatches, true)
  return value
}
function runSafetySmoke({ maestro, device, output, orientations }) {
  const fixture = safetyFixture(), ios = process.platform === 'darwin'
  if (process.env.GITHUB_ACTIONS !== 'true' || !['linux', 'darwin'].includes(process.platform)) throw new Error('Use an owned Actions device.')
  const source = process.env.CYNTCH_IOS_APP_SHA || process.env.CYNTCH_ANDROID_APP_SHA || process.env.GITHUB_SHA
  assert.match(source, /^[a-f0-9]{40}$/)
  const command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024 }).trim()
  const adb = (...args) => command('adb', ['-s', device, ...args])
  const simctl = (...args) => command('xcrun', ['simctl', ...args])
  const attest = final => validateAttestation(JSON.parse(command(ios ? '/usr/bin/curl' : 'curl', ['--fail', '--silent', '--show-error', '--max-time', '20',
    '--header', 'ngrok-skip-browser-warning: 1', fixture.origin + '/__cyntch-native-safety-fixture'])), ios ? 'ios' : 'android', source, final)
  let before
  if (ios) {
    network.requireOwnedHost()
    const inventory = JSON.parse(simctl('list', 'devices', '--json'))
    const owned = Object.values(inventory.devices).flat().find(row => row.udid === device)
    if (owned?.name !== `Cyntch-${process.env.GITHUB_RUN_ID}-iphone` || owned.state !== 'Booted') throw new Error('The safety simulator is not owned by this job.')
  } else {
    if (device !== 'emulator-5554' || adb('shell', 'getprop', 'ro.kernel.qemu') !== '1' || adb('emu', 'avd', 'name').split(/\r?\n/)[0] !== 'cyntch-phone') throw new Error('Use the owned phone emulator.')
    before = { wifi: adb('shell', 'settings', 'get', 'global', 'wifi_on'), data: adb('shell', 'settings', 'get', 'global', 'mobile_data') }
    assert.ok(Object.values(before).every(value => ['0', '1'].includes(value)))
  }
  fs.mkdirSync(output, { recursive: true })
  const result = { source, verificationSource: process.env.GITHUB_SHA, scope: 'Private fixture only: explicit terms, report draft rotation/restart, offline submission, process stop, receipt on reconnection and receipt restart.', passed: false }
  const folder = path.join(output, 'network')
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  function flow(name, timeout = 300000) {
    const evidence = path.join(output, name); fs.mkdirSync(evidence, { recursive: true })
    const log = fs.openSync(path.join(evidence, 'maestro.log'), 'w')
    try {
      const run = (ios ? runIOSUI : spawnSync)(maestro, ['--device', device, 'test', '--format', 'junit', '--output', path.join(evidence, 'report.xml'),
        '-e', `PORTRAIT_ORIENTATION=${orientations.portrait}`, '-e', `LANDSCAPE_ORIENTATION=${orientations.landscape}`,
        '--test-output-dir', evidence, '--debug-output', evidence, path.resolve('.maestro-safety', name + '.yaml')], { stdio: ['ignore', log, log], timeout, env: process.env })
      if (run.error || run.status !== 0) throw new Error(`Safety ${name} failed (${run.error?.code ?? run.status}). Inspect retained evidence before continuing.`)
    } finally { fs.closeSync(log) }
  }
  let disconnected = false
  function restore() {
    if (ios) {
      result.networkRestoration = network.restore(folder)
      assert.equal(result.networkRestoration.reason, 'requested')
    } else {
      for (const [kind, value] of Object.entries(before)) adb('shell', 'svc', kind, value === '1' ? 'enable' : 'disable')
      result.networkRestoration = { wifi: adb('shell', 'settings', 'get', 'global', 'wifi_on'), data: adb('shell', 'settings', 'get', 'global', 'mobile_data') }
      assert.deepEqual(result.networkRestoration, before)
    }
    disconnected = false
  }
  try {
    // An existing acceptance/report stops the whole journey before another save.
    result.before = attest(false); save()
    flow('prepare', 540000)
    disconnected = true
    if (ios) { result.network = network.disconnect(folder); result.unreachable = network.assertUnavailable(fixture.origin) }
    else { adb('shell', 'svc', 'wifi', 'disable'); adb('shell', 'svc', 'data', 'disable') }
    flow('submit-offline', 100000); result.submittedOffline = true; save()
    if (ios) simctl('terminate', device, 'com.cyntch.app')
    else {
      adb('shell', 'am', 'force-stop', 'com.cyntch.app')
      const pid = spawnSync('adb', ['-s', device, 'shell', 'pidof', 'com.cyntch.app'], { encoding: 'utf8', timeout: 20000 })
      if (pid.error || ![0, 1].includes(pid.status) || pid.stdout.trim()) throw new Error('Cyntch remains running after force-stop.')
    }
    result.processStopAcknowledged = true
    flow('restart-offline', 100000); result.pendingAfterRestart = true; save()
    if (ios) result.unreachableAfterRestart = network.assertUnavailable(fixture.origin)
    restore()
    flow('reconnect'); result.after = attest(true)
    result.screenshots = inspectScreenshotOrientations(output, {
      'terms-unaccepted-portrait.png': 'portrait', 'terms-unaccepted-landscape.png': 'landscape',
      'report-draft-after-restart.png': 'portrait', 'report-draft-landscape.png': 'landscape',
      'report-pending-offline.png': 'portrait', 'report-pending-after-kill.png': 'portrait',
      'report-received.png': 'portrait', 'report-receipt-after-restart.png': 'portrait',
    }, { includeStartup: false })
    if (!result.screenshots.passed) throw new Error('Safety journey lacks required orientation/recovery captures.')
    result.passed = true
  } catch (error) { result.error = error.message }
  finally {
    if (disconnected) try { restore() } catch (error) { result.restoreError = error.message; result.passed = false }
    save()
  }
  return result
}
module.exports = { safetyFixture, validateAttestation, runSafetySmoke }
