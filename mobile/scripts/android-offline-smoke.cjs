const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { authFixture } = require('./native-auth-smoke.cjs')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')

function runOfflineSmoke({ maestro, device, output, orientations }) {
  if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true' || !authFixture()) throw new Error('Offline verification requires the isolated Actions fixture.')
  const adb = (...args) => execFileSync('adb', ['-s', device, ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 }).trim()
  if (device !== 'emulator-5554' || adb('shell', 'getprop', 'ro.kernel.qemu') !== '1' || adb('emu', 'avd', 'name').split(/\r?\n/)[0] !== 'cyntch-phone') throw new Error('Offline verification requires the owned phone emulator.')
  fs.mkdirSync(output, { recursive: true })
  const result = { source: process.env.CYNTCH_ANDROID_APP_SHA || process.env.GITHUB_SHA, verificationSource: process.env.GITHUB_SHA,
    scope: 'Offline completion, force-stop persistence, reconnect acknowledgement and acknowledged reopening of a disposable task.', passed: false }
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  const read = key => adb('shell', 'settings', 'get', 'global', key)
  const before = { wifi: read('wifi_on'), data: read('mobile_data') }
  if (![before.wifi, before.data].every(value => ['0','1'].includes(value))) throw new Error('Cannot verify initial emulator network settings.')
  result.networkBefore = before
  let changed = false
  function restore() {
    const errors = []
    for (const [kind, value] of Object.entries(before)) {
      try { adb('shell', 'svc', kind, value === '1' ? 'enable' : 'disable') }
      catch (error) { errors.push(error.message) }
    }
    if (errors.length) throw new Error('Could not restore emulator network settings.')
    changed = false
    result.networkRestoreRequested = true
  }
  function flow(name) {
    const folder = path.join(output, name); fs.mkdirSync(folder, { recursive: true })
    const log = fs.openSync(path.join(folder, 'maestro.log'), 'w')
    try {
      const run = spawnSync(maestro, ['--device', device, 'test', '--format', 'junit', '--output', path.join(folder, 'report.xml'),
        '-e', `PORTRAIT_ORIENTATION=${orientations.portrait}`, '--test-output-dir', folder, '--debug-output', folder,
        path.resolve('.maestro-offline', name + '.yaml')], { stdio: ['ignore', log, log], timeout: 240000, env: process.env })
      if (run.error || run.status !== 0) throw new Error(`Offline ${name} flow failed (${run.error?.code ?? run.status}).`)
    } finally { fs.closeSync(log) }
  }
  try {
    flow('prepare')
    changed = true
    adb('shell', 'svc', 'wifi', 'disable'); adb('shell', 'svc', 'data', 'disable')
    // The UI must observe actual loss of connectivity before editing. Merely
    // asking Android to disable radios is not accepted as offline evidence.
    flow('complete')
    result.completedOffline = true; save()
    adb('shell', 'am', 'force-stop', 'com.cyntch.app')
    const pid = spawnSync('adb', ['-s', device, 'shell', 'pidof', 'com.cyntch.app'], { encoding: 'utf8', timeout: 20000 })
    if (pid.error || ![0,1].includes(pid.status) || pid.stdout.trim()) throw new Error('Cyntch still has a process after force-stop.')
    result.processStopped = true
    flow('restart'); result.survivedOfflineRestart = true; save()
    restore()
    flow('reconnect')
    result.synchronizedAndReopened = true
    result.networkAfter = { wifi: read('wifi_on'), data: read('mobile_data') }
    if (JSON.stringify(result.networkAfter) !== JSON.stringify(before)) throw new Error('Emulator network settings did not return to their original state.')
    result.screenshots = inspectScreenshotOrientations(output, Object.fromEntries([
      'offline-before-edit', 'offline-completion-saved', 'offline-completion-after-kill',
      'offline-completion-synced', 'offline-task-restored-after-restart',
    ].map(name => [name + '.png', 'portrait'])), { includeStartup: false })
    if (!result.screenshots.passed) throw new Error('Offline journey captures are incomplete.')
    result.passed = true
  } catch (error) { result.error = error.message }
  finally {
    if (changed) {
      try { restore() } catch (error) { result.restoreError = error.message; result.passed = false }
    }
    save()
  }
  return result
}
module.exports = { runOfflineSmoke }
