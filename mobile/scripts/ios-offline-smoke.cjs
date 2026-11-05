const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { authFixture } = require('./native-auth-smoke.cjs')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')
const { runIOSUI } = require('../../.github/scripts/ios-device-process.cjs')
const { ownedAppExecutable } = require('../../.github/scripts/ios-device-app.cjs')
const network = require('../../.github/scripts/ios-device-network.cjs')

function runOfflineSmoke({ maestro, device, output }) {
  network.requireOwnedHost()
  const fixture = authFixture()
  if (!fixture || fixture.email !== 'cyntch-native-20261103+clerk_test@example.com' || !/^[a-f0-9-]{36}$/i.test(device)) throw new Error('Offline verification requires the ordinary isolated iPhone fixture.')
  const command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 }).trim()
  const simctl = (...args) => command('xcrun', ['simctl', ...args])
  const inventory = JSON.parse(simctl('list', 'devices', '--json'))
  const owned = Object.values(inventory.devices).flat().find(row => row.udid === device)
  if (owned?.name !== `Cyntch-${process.env.GITHUB_RUN_ID}-iphone` || owned.state !== 'Booted') throw new Error('The offline simulator is not owned by this job.')
  const bundle = fs.realpathSync(simctl('get_app_container', device, 'com.cyntch.app', 'app'))
  const application = { device, dataPath: fs.realpathSync(owned.dataPath), bundle,
    identifier: command('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(bundle, 'Info.plist')]),
    executable: command('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(bundle, 'Info.plist')]) }
  const executable = ownedAppExecutable(application)
  const pids = () => command('/bin/ps', ['-axo', 'pid=,command=']).split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(.+)$/.exec(line)
    return row && (row[2] === executable || row[2].startsWith(executable + ' ')) ? [Number(row[1])] : []
  })
  fs.mkdirSync(output, { recursive: true })
  const folder = path.join(output, 'network')
  const result = { source: process.env.CYNTCH_IOS_APP_SHA, verificationSource: process.env.GITHUB_SHA,
    ownedApplication: application,
    scope: 'Actual hosted interface outage: offline task completion, terminated-process restart, reconnect acknowledgement and task reopening. Uses the shared disposable task named Android offline verification.', passed: false }
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  function flow(name, timeout = 180000) {
    const evidence = path.join(output, name); fs.mkdirSync(evidence, { recursive: true })
    const log = fs.openSync(path.join(evidence, 'maestro.log'), 'w')
    try {
      const run = runIOSUI(maestro, ['--device', device, 'test', '--format', 'junit', '--output', path.join(evidence, 'report.xml'),
        '-e', 'PORTRAIT_ORIENTATION=PORTRAIT', '--test-output-dir', evidence, '--debug-output', evidence,
        path.resolve('.maestro-offline', name + '.yaml')], { stdio: ['ignore', log, log], timeout, env: process.env })
      if (run.error || run.status !== 0) throw new Error(`Offline ${name} failed (${run.error?.code ?? run.status}).`)
    } finally { fs.closeSync(log) }
  }
  let disconnected = false
  try {
    flow('prepare')
    result.network = network.disconnect(folder); disconnected = true
    result.unreachableBeforeEdit = network.assertUnavailable(fixture.origin)
    flow('complete', 100000)
    result.completedOffline = true; save()
    result.runningPids = pids()
    if (result.runningPids.length !== 1) throw new Error('Expected exactly one owned Cyntch process before termination.')
    simctl('terminate', device, 'com.cyntch.app')
    if (pids().length) throw new Error('Cyntch still has a process after termination.')
    result.processStopped = true
    flow('restart', 100000)
    result.unreachableAfterRestart = network.assertUnavailable(fixture.origin)
    if (fs.existsSync(path.join(folder, 'restored.json'))) throw new Error('The network watchdog expired before offline verification completed.')
    result.survivedOfflineRestart = true; save()
    result.networkRestoration = network.restore(folder); disconnected = false
    if (result.networkRestoration.reason !== 'requested') throw new Error('Offline verification exceeded the bounded network outage.')
    flow('reconnect')
    result.synchronizedAndReopened = true
    result.screenshots = inspectScreenshotOrientations(output, Object.fromEntries([
      'offline-before-edit', 'offline-completion-saved', 'offline-completion-after-kill',
      'offline-completion-synced', 'offline-task-restored-after-restart',
    ].map(name => [name + '.png', 'portrait'])), { includeStartup: false })
    if (!result.screenshots.passed) throw new Error('Offline journey captures are incomplete.')
    result.passed = true
  } catch (error) { result.error = error.message }
  finally {
    if (disconnected) {
      try { result.networkRestoration = network.restore(folder) }
      catch (error) { result.restoreError = error.message; result.passed = false }
    }
    save()
  }
  return result
}
module.exports = { runOfflineSmoke }
