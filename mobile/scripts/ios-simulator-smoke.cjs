// Runs only on the disposable macOS Actions host. Default flows stay signed out;
// explicit fixture inputs add development-only sign-in and household checks.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')
const { authFixture, runAuthenticatedSmoke } = require('./native-auth-smoke.cjs')
const { runNotificationSmoke } = require('./ios-notification-smoke.cjs')
const { runKioskSmoke } = require('./native-kiosk-smoke.cjs')
const { runNotificationPreferencesSmoke } = require('./native-notification-preferences-smoke.cjs')
const { deletionFixture, runAccountDeletionSmoke } = require('./native-account-deletion-smoke.cjs')
const { runIOSUI, canRetryIOSBootstrap } = require('../../.github/scripts/ios-device-process.cjs')
const { collectStartupDiagnostics } = require('../../.github/scripts/ios-device-startup-diagnostics.cjs')

function hasFlowEvidence(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).some(entry => entry.isDirectory()
    ? hasFlowEvidence(path.join(folder, entry.name))
    : entry.name === 'commands.json' || entry.name === 'report.xml' || entry.name.endsWith('.png'))
}

if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Run this verification on the macOS GitHub Actions host.')
}
if (process.argv.length !== 5) throw new Error('Expected simulator app, Maestro executable and output directory.')
const [appPath, maestro, output] = process.argv.slice(2).map(value => path.resolve(value))
const fixture = authFixture()
const requestedFamily = process.env.CYNTCH_IOS_TEST_FAMILY
const replay = process.env.CYNTCH_IOS_REPLAY_SCOPE
const notificationsOnly = replay === 'notifications'
const deletionOnly = replay === 'account-deletion'
if (replay && (!['notifications','current-devices','minimum-devices','phones','account-deletion'].includes(replay) || !fixture || !/^[a-f0-9]{40}$/.test(process.env.CYNTCH_IOS_APP_SHA ?? ''))) throw new Error('Replaying a simulator check requires a verified app and sign-in fixture.')
if (replay === 'phones' && requestedFamily !== 'iphone') throw new Error('Phone replay cannot repeat a tablet job.')
if (notificationsOnly && (requestedFamily !== 'iphone' || process.env.CYNTCH_IOS_TEST_RUNTIME)) throw new Error('The notification check requires a current iPhone.')
if (deletionOnly) {
  deletionFixture()
  if (requestedFamily !== 'iphone' || process.env.CYNTCH_IOS_TEST_RUNTIME) throw new Error('The isolated deletion check requires a current iPhone.')
}
if (requestedFamily && !['iphone', 'ipad'].includes(requestedFamily)) throw new Error('Unknown simulator family.')
if (!appPath || !maestro || !output || !fs.existsSync(path.join(appPath, 'main.jsbundle'))) {
  throw new Error('A compiled simulator app with bundled JavaScript is required.')
}
fs.mkdirSync(output, { recursive: true })
// On cold hosts simctl help may time out before CoreSimulator is available.
// The actual set/readback on each booted device below is the feature check.
const command = (executable, args, timeout = 60_000) => {
  const label = `${executable} ${args.slice(0, 2).join(' ')}`, start = Date.now()
  console.log(`Starting ${label} (timeout ${timeout / 1000}s)`)
  try { return execFileSync(executable, args, { encoding: 'utf8', timeout, maxBuffer: 12 * 1024 * 1024 }) }
  catch (error) { throw new Error(`${label} failed: ${error.code ?? error.message}`, { cause: error }) }
  finally { console.log(`Finished ${label} after ${((Date.now() - start) / 1000).toFixed(1)}s`) }
}
const simctl = (...args) => command('xcrun', ['simctl', ...args])
const inventory = JSON.parse(command('xcrun', ['simctl', 'list', '--json'], 180_000))
fs.writeFileSync(path.join(output, 'simulator-inventory.json'), JSON.stringify(inventory, null, 2))
const requestedRuntime = process.env.CYNTCH_IOS_TEST_RUNTIME
if (requestedRuntime && requestedRuntime !== '17.0') throw new Error('The configured minimum-iOS check requires exactly iOS 17.0.')
const candidates = inventory.runtimes.filter(runtime => runtime.isAvailable && runtime.identifier.includes('.iOS-'))
  .sort((left, right) => right.version.localeCompare(left.version, 'en', { numeric: true }))
const runtime = candidates.find(item => {
  if (requestedRuntime) return item.version === requestedRuntime
  const devices = (inventory.devices[item.identifier] ?? []).filter(device => device.isAvailable)
  return devices.some(device => device.name.startsWith('iPhone')) && devices.some(device => device.name.startsWith('iPad'))
})
if (!runtime) throw new Error(requestedRuntime ? 'The required iOS 17.0 runtime is not available; do not substitute a newer OS.'
  : 'An installed iOS runtime with both phone and tablet device types is required.')
const available = (inventory.devices[runtime.identifier] ?? []).filter(device => device.isAvailable)
// A newly imported runtime need not have any pre-created simulator instances.
// Select device types supported at the original iOS 17 release instead.
const devices = requestedRuntime ? ['iPhone 15', 'iPad (10th generation)'].map(name => {
  const type = inventory.devicetypes.find(item => item.name === name)
  if (!type) throw new Error(`Required minimum-iOS device type is missing: ${name}`)
  return { name, deviceTypeIdentifier: type.identifier }
}) : [
  available.find(device => device.name === 'iPhone 17') ?? available.find(device => device.name.startsWith('iPhone')),
  available.find(device => device.name === 'iPad (A16)') ?? available.find(device => device.name.startsWith('iPad')),
]
const report = { source: process.env.CYNTCH_IOS_APP_SHA || process.env.GITHUB_SHA, verificationSource: process.env.GITHUB_SHA,
  scope: deletionOnly ? 'Disposable development account deletion and device recovery' : notificationsOnly ? 'Authenticated notification permission and Notification Center' : 'Device text sizes and optional household verification',
  configuration: 'Release with local simulator signing', runtime: runtime.name,
  hostArchitecture: process.arch, runtimeVersion: runtime.version, requestedRuntime: requestedRuntime ?? 'latest installed', devices: [], passed: false }
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
let failed = false
for (const [index, template] of devices.entries()) {
  const label = index === 0 ? 'iphone' : 'ipad'
  if (requestedFamily && label !== requestedFamily) continue
  const type = template.deviceTypeIdentifier ?? inventory.devicetypes.find(item => item.name === template.name)?.identifier
  if (!type) throw new Error(`No simulator type found for ${template.name}`)
  const folder = path.join(output, label)
  fs.mkdirSync(folder, { recursive: true })
  const result = { family: label, model: template.name, type, runs: [], passed: false, cleaned: false }
  report.devices.push(result)
  save()
  const stage = name => { result.stage = name; save() }
  let ownedDevice
  try {
    stage('create')
    ownedDevice = simctl('create', `Cyntch-${process.env.GITHUB_RUN_ID}-${label}`, type, runtime.identifier).trim()
    if (!/^[0-9a-f-]{36}$/i.test(ownedDevice)) throw new Error('Unexpected created simulator identifier.')
    console.log(`Verifying ${template.name} on ${runtime.name} (${ownedDevice})`)
    stage('boot')
    simctl('boot', ownedDevice)
    stage('wait-for-boot')
    result.bootObservations = []
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now()
      const boot = spawnSync('xcrun', ['simctl', 'bootstatus', ownedDevice, '-b'], {
        encoding: 'utf8', timeout: 300_000, maxBuffer: 12 * 1024 * 1024,
      })
      fs.writeFileSync(path.join(folder, `boot-${attempt}.log`), `${boot.stdout ?? ''}\n${boot.stderr ?? ''}`)
      const observation = { attempt, elapsedSeconds: (Date.now() - started) / 1000,
        exitCode: boot.status, error: boot.error?.code }
      result.bootObservations.push(observation)
      save()
      if (!boot.error && boot.status === 0) break
      if (boot.error?.code !== 'ETIMEDOUT') throw new Error(`Simulator boot failed (${boot.error?.code ?? boot.status}).`)
      if (attempt === 2) throw new Error('Simulator did not finish booting within the ten-minute test setup budget.')
      // Reattach the observer to this UDID. A second inventory lookup during
      // first-boot migration can time out independently of bootstatus.
      console.log(`Continuing boot observation on the same ${template.name}.`)
    }
    // simctl and Maestro both target the booted UDID directly. There is no
    // reason to launch a desktop Simulator window to install or inspect the app.
    stage('install')
    command('xcrun', ['simctl', 'install', ownedDevice, appPath], 180_000)
    if (!simctl('get_app_container', ownedDevice, 'com.cyntch.app', 'app').trim().endsWith('.app')) throw new Error('Installed application bundle not found.')
    stage('launch')
    const launched = command('xcrun', ['simctl', 'launch', ownedDevice, 'com.cyntch.app'], 120_000).trim()
    const launchPid = /^com\.cyntch\.app:\s*(\d+)$/m.exec(launched)
    if (!launchPid) throw new Error('CoreSimulator did not acknowledge the application launch.')
    result.launchPid = Number(launchPid[1])
    save()
    // Do not block the first UI action on a screenshot of a cold simulator.
    // The journeys require their own rendered evidence; finally also records
    // the visible screen if a journey fails before reaching an assertion.
    for (const contentSize of (notificationsOnly || deletionOnly ? [] : ['large', 'accessibility-extra-large'])) {
      const caseFolder = path.join(folder, contentSize === 'large' ? 'default-text' : 'large-text')
      fs.mkdirSync(caseFolder, { recursive: true })
      const textResult = { contentSize, passed: false }
      result.runs.push(textResult)
      stage(`text-size:${contentSize}`)
      try {
        simctl('ui', ownedDevice, 'content_size', contentSize)
        textResult.actualContentSize = simctl('ui', ownedDevice, 'content_size').trim()
        if (textResult.actualContentSize.toLowerCase() !== contentSize) {
          throw new Error('The requested Dynamic Type size was not applied.')
        }
        stage(`test-flow:${contentSize}`)
        let run
        textResult.attempts = []
        for (let attempt = 1; attempt <= 2; attempt++) {
          const attemptFolder = attempt === 1 ? caseFolder : path.join(caseFolder, 'bootstrap-retry')
          fs.mkdirSync(attemptFolder, { recursive: true })
          const log = fs.openSync(path.join(attemptFolder, 'maestro.log'), 'w')
          try {
            run = runIOSUI(maestro, [
              '--device', ownedDevice, 'test', '-e', `IOS_FAMILY=${label}`, '--format', 'junit', '--output', path.join(attemptFolder, 'report.xml'),
              '--test-output-dir', attemptFolder, '--debug-output', attemptFolder, path.resolve('.maestro'),
            ], { stdio: ['ignore', log, log], timeout: 540_000, env: process.env })
          } finally { fs.closeSync(log) }
          const driverOutput = fs.readFileSync(path.join(attemptFolder, 'maestro.log'), 'utf8')
          console.log(driverOutput)
          const retryBootstrap = attempt === 1 && canRetryIOSBootstrap(run, driverOutput, hasFlowEvidence(attemptFolder))
          textResult.attempts.push({ attempt, exitCode: run.status, error: run.error?.code, driverCleanup: run.driverCleanup, retryBootstrap })
          save()
          if (!retryBootstrap) break
          console.log('Retrying the unstarted iOS driver once after cleaning its owned process group; first-attempt evidence is retained.')
        }
        textResult.exitCode = run.status
        textResult.driverCleanup = run.driverCleanup
        textResult.orientationEvidence = inspectScreenshotOrientations(caseFolder, {
          'native-keyboard-portrait.png': 'portrait',
          'native-keyboard-landscape.png': 'landscape',
          'native-keyboard-dismissed-landscape.png': 'landscape',
        })
        if (run.error || run.status !== 0) throw new Error(`Simulator flow failed (${run.error?.code ?? run.status}).`)
        if (!textResult.orientationEvidence.passed) throw new Error('Screenshots do not prove both requested orientations.')
        textResult.passed = true
      } catch (error) {
        textResult.error = error.message
        console.error(`${template.name}, ${contentSize}: ${error.message}`)
      } finally {
        try { simctl('io', ownedDevice, 'screenshot', path.join(caseFolder, 'last-screen.png')) } catch { /* Retain other case evidence. */ }
        save()
      }
    }
    if (fixture) {
      stage('authenticated-household')
      simctl('ui', ownedDevice, 'content_size', 'large')
      if (simctl('ui', ownedDevice, 'content_size').trim().toLowerCase() !== 'large') throw new Error('Default text size was not restored for authenticated verification.')
      result.authentication = runAuthenticatedSmoke({ maestro, device: ownedDevice, output: path.join(folder, 'authenticated'),
        orientations: { portrait: 'PORTRAIT', landscape: 'LANDSCAPE_LEFT' }, fixture })
    }
    if (result.authentication && !result.authentication.passed) throw new Error(result.authentication.error)
    if (result.authentication?.passed && label === 'ipad' && !requestedRuntime) {
      stage('kiosk-restart-and-parent-access')
      result.kiosk = runKioskSmoke({ maestro, device: ownedDevice, output: path.join(folder, 'kiosk'),
        orientations: { portrait: 'PORTRAIT', landscape: 'LANDSCAPE_LEFT' } })
      if (!result.kiosk.passed) throw new Error(result.kiosk.error)
    }
    if (result.authentication?.passed && label === 'iphone' && !requestedRuntime && (!replay || notificationsOnly || replay === 'phones')) {
      stage('notification-permission-and-center')
      result.notifications = runNotificationSmoke({device:ownedDevice,maestro,output:path.join(folder,'notifications')})
      if (!result.notifications.passed) throw new Error(result.notifications.error)
      stage('notification-preferences-and-restart')
      result.notificationPreferences = runNotificationPreferencesSmoke({ maestro, device: ownedDevice,
        output: path.join(folder, 'notification-preferences'), orientations: { portrait: 'PORTRAIT', landscape: 'LANDSCAPE_LEFT' } })
      if (!result.notificationPreferences.passed) throw new Error(result.notificationPreferences.error)
    }
    if (result.authentication?.passed && deletionOnly) {
      stage('account-deletion-and-device-recovery')
      result.accountDeletion = runAccountDeletionSmoke({ maestro, device: ownedDevice, output: path.join(folder, 'account-deletion'),
        orientations: { portrait: 'PORTRAIT', landscape: 'LANDSCAPE_LEFT' } })
      if (!result.accountDeletion.passed) throw new Error(result.accountDeletion.error)
    }
    if (result.runs.some(run => !run.passed)) throw new Error('Simulator flow failed at one or more text sizes.')
    result.passed = true
    stage('completed')
  } catch (error) {
    failed = true
    result.error = error.message
    console.error(`${template.name}: ${error.message}`)
  } finally {
    if (ownedDevice && /^[0-9a-f-]{36}$/i.test(ownedDevice)) {
      try { simctl('io', ownedDevice, 'screenshot', path.join(folder, 'last-screen.png')) } catch { /* Device may not have booted. */ }
      if (!result.passed && ['boot', 'install', 'launch'].includes(result.stage)) {
        try { result.startupDiagnostics = collectStartupDiagnostics(ownedDevice, path.join(folder, 'startup-diagnostics')) }
        catch (error) { result.startupDiagnosticsError = error.message }
      }
      try {
        const logs = command('xcrun', ['simctl', 'spawn', ownedDevice, 'log', 'show', '--style', 'compact', '--last', '15m', '--predicate', 'process == "Cyntch"'], 30_000)
        fs.writeFileSync(path.join(folder, 'application.log'), logs)
      } catch { /* Maestro evidence and the flow result still remain available. */ }
      try { simctl('shutdown', ownedDevice) } catch { /* It may already be shut down. */ }
      try { simctl('delete', ownedDevice); result.cleaned = true }
      catch { failed = true; result.cleanupError = 'Unable to remove the created simulator.' }
    }
    save()
  }
}
report.passed = !failed
save()
if (failed) process.exitCode = 1
