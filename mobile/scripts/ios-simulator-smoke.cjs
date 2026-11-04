// Runs only on the disposable macOS Actions host. Default flows stay signed out;
// explicit fixture inputs add development-only sign-in and household checks.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')
const { authFixture, runAuthenticatedSmoke } = require('./native-auth-smoke.cjs')

if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Run this verification on the macOS GitHub Actions host.')
}
if (process.argv.length !== 5) throw new Error('Expected simulator app, Maestro executable and output directory.')
const [appPath, maestro, output] = process.argv.slice(2).map(value => path.resolve(value))
const fixture = authFixture()
if (!appPath || !maestro || !output || !fs.existsSync(path.join(appPath, 'main.jsbundle'))) {
  throw new Error('A compiled simulator app with bundled JavaScript is required.')
}
fs.mkdirSync(output, { recursive: true })
// Keep the installed Xcode command reference beside the runtime evidence.
const help = spawnSync('xcrun', ['simctl', 'help', 'ui'], { encoding: 'utf8', timeout: 30_000 })
const helpText = `${help.stdout ?? ''}\n${help.stderr ?? ''}`
fs.writeFileSync(path.join(output, 'simctl-ui-help.txt'), helpText)
if (help.error || help.status !== 0 || !helpText.includes('content_size')) {
  throw new Error('The installed simulator must support querying and setting Dynamic Type.')
}
const command = (executable, args, timeout = 60_000) => {
  const label = `${executable} ${args.slice(0, 2).join(' ')}`, start = Date.now()
  console.log(`Starting ${label} (timeout ${timeout / 1000}s)`)
  try { return execFileSync(executable, args, { encoding: 'utf8', timeout, maxBuffer: 12 * 1024 * 1024 }) }
  catch (error) { throw new Error(`${label} failed: ${error.code ?? error.message}`, { cause: error }) }
  finally { console.log(`Finished ${label} after ${((Date.now() - start) / 1000).toFixed(1)}s`) }
}
const simctl = (...args) => command('xcrun', ['simctl', ...args])
const inventory = JSON.parse(simctl('list', '--json'))
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
const report = { source: process.env.GITHUB_SHA, configuration: 'Release with local simulator signing', runtime: runtime.name,
  hostArchitecture: process.arch, runtimeVersion: runtime.version, requestedRuntime: requestedRuntime ?? 'latest installed', devices: [], passed: false }
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
let failed = false
for (const [index, template] of devices.entries()) {
  const type = template.deviceTypeIdentifier ?? inventory.devicetypes.find(item => item.name === template.name)?.identifier
  if (!type) throw new Error(`No simulator type found for ${template.name}`)
  const label = index === 0 ? 'iphone' : 'ipad'
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
      const current = JSON.parse(simctl('list', 'devices', '--json'))
      const device = Object.values(current.devices).flat().find(item => item.udid === ownedDevice)
      observation.deviceState = device?.state ?? 'missing'
      save()
      if (!device || !['Booted', 'Booting'].includes(device.state)) throw new Error('Simulator stopped during boot observation.')
      if (attempt === 2) throw new Error('Simulator did not finish booting within the ten-minute test setup budget.')
      // The observer timed out, but the simulator is still live. Continue waiting
      // on the same owned device; do not reboot it or discard its migration work.
      console.log(`${template.name} is still ${device.state}; continuing boot observation.`)
    }
    stage('open-simulator')
    command('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', ownedDevice])
    simctl('ui', ownedDevice, 'appearance', 'light')
    stage('install')
    simctl('install', ownedDevice, appPath)
    for (const contentSize of ['large', 'accessibility-extra-large']) {
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
        const log = fs.openSync(path.join(caseFolder, 'maestro.log'), 'w')
        let run
        try {
          run = spawnSync(maestro, [
            '--device', ownedDevice, 'test', '--format', 'junit', '--output', path.join(caseFolder, 'report.xml'),
            '--test-output-dir', caseFolder, '--debug-output', caseFolder, path.resolve('.maestro'),
          ], { stdio: ['ignore', log, log], timeout: 300_000, env: process.env })
        } finally { fs.closeSync(log) }
        console.log(fs.readFileSync(path.join(caseFolder, 'maestro.log'), 'utf8'))
        textResult.exitCode = run.status
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
