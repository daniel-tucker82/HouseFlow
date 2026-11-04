// Runs only on the disposable macOS Actions host. No accounts, credentials,
// production API or local developer simulators are used by this signed-out flow.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Run this verification on the macOS GitHub Actions host.')
}
const [appPath, maestro, output] = process.argv.slice(2).map(value => path.resolve(value))
if (!appPath || !maestro || !output || !fs.existsSync(path.join(appPath, 'main.jsbundle'))) {
  throw new Error('A compiled simulator app with bundled JavaScript is required.')
}
fs.mkdirSync(output, { recursive: true })
const command = (executable, args, timeout = 60_000) => execFileSync(executable, args, {
  encoding: 'utf8', timeout, maxBuffer: 12 * 1024 * 1024,
})
const simctl = (...args) => command('xcrun', ['simctl', ...args])
const inventory = JSON.parse(simctl('list', '--json'))
const candidates = inventory.runtimes.filter(runtime => runtime.isAvailable && runtime.identifier.includes('.iOS-'))
  .sort((left, right) => right.version.localeCompare(left.version, 'en', { numeric: true }))
const runtime = candidates.find(item => {
  const devices = (inventory.devices[item.identifier] ?? []).filter(device => device.isAvailable)
  return devices.some(device => device.name.startsWith('iPhone')) && devices.some(device => device.name.startsWith('iPad'))
})
if (!runtime) throw new Error('An installed iOS runtime with both phone and tablet device types is required.')
const available = inventory.devices[runtime.identifier].filter(device => device.isAvailable)
const devices = [
  available.find(device => device.name === 'iPhone 17') ?? available.find(device => device.name.startsWith('iPhone')),
  available.find(device => device.name === 'iPad (A16)') ?? available.find(device => device.name.startsWith('iPad')),
]
const report = { source: process.env.GITHUB_SHA, configuration: 'Release', runtime: runtime.name, devices: [] }
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
let failed = false
for (const [index, template] of devices.entries()) {
  const type = template.deviceTypeIdentifier ?? inventory.devicetypes.find(item => item.name === template.name)?.identifier
  if (!type) throw new Error(`No simulator type found for ${template.name}`)
  const label = index === 0 ? 'iphone' : 'ipad'
  const folder = path.join(output, label)
  fs.mkdirSync(folder, { recursive: true })
  const result = { family: label, model: template.name, type, passed: false, cleaned: false }
  report.devices.push(result)
  save()
  let ownedDevice
  try {
    ownedDevice = simctl('create', `Cyntch-${process.env.GITHUB_RUN_ID}-${label}`, type, runtime.identifier).trim()
    if (!/^[0-9a-f-]{36}$/i.test(ownedDevice)) throw new Error('Unexpected created simulator identifier.')
    console.log(`Verifying ${template.name} on ${runtime.name} (${ownedDevice})`)
    simctl('boot', ownedDevice)
    command('xcrun', ['simctl', 'bootstatus', ownedDevice, '-b'], 180_000)
    command('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', ownedDevice])
    simctl('ui', ownedDevice, 'appearance', 'light')
    simctl('install', ownedDevice, appPath)
    const run = spawnSync(maestro, [
      '--device', ownedDevice, 'test', '--format', 'junit', '--output', path.join(folder, 'report.xml'),
      '--test-output-dir', folder, '--debug-output', folder, path.resolve('.maestro/signed-out.yaml'),
    ], { stdio: 'inherit', timeout: 300_000, env: process.env })
    result.exitCode = run.status
    if (run.error || run.status !== 0) throw new Error(`Simulator flow failed (${run.error?.code ?? run.status}).`)
    result.passed = true
  } catch (error) {
    failed = true
    result.error = error.message
    console.error(`${template.name}: ${error.message}`)
  } finally {
    if (ownedDevice && /^[0-9a-f-]{36}$/i.test(ownedDevice)) {
      try { simctl('io', ownedDevice, 'screenshot', path.join(folder, 'last-screen.png')) } catch { /* Device may not have booted. */ }
      try {
        const logs = command('xcrun', ['simctl', 'spawn', ownedDevice, 'log', 'show', '--style', 'compact', '--last', '5m', '--predicate', 'process == "Cyntch"'], 30_000)
        fs.writeFileSync(path.join(folder, 'application.log'), logs)
      } catch { /* Maestro evidence and the flow result still remain available. */ }
      try { simctl('shutdown', ownedDevice) } catch { /* It may already be shut down. */ }
      try { simctl('delete', ownedDevice); result.cleaned = true }
      catch { failed = true; result.cleanupError = 'Unable to remove the created simulator.' }
    }
    save()
  }
}
if (failed) process.exitCode = 1
