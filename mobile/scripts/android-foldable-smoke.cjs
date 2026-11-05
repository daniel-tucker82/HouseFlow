// State retention across actual emulator fold/unfold commands. This only runs
// on the named disposable Actions AVD; no user device or real account is used.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { screenshotDimensions } = require('./device-screenshot-evidence.cjs')

if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Run this verification on the Linux GitHub Actions host.')
}
if (process.argv.length !== 5) throw new Error('Expected APK, Maestro executable and output directory.')
const [apk, maestro, output] = process.argv.slice(2).map(value => path.resolve(value))
if (!fs.existsSync(apk) || !fs.existsSync(maestro)) throw new Error('Compiled APK and Maestro are required.')
fs.mkdirSync(output, { recursive: true })
const serial = 'emulator-5554'
const report = {
  source: process.env.GITHUB_SHA, serial, expectedApiLevel: '37',
  configuration: 'Release, minified, x86_64, development signing only',
  scope: 'Fold/unfold/fold a populated native sign-in form at default and enlarged text sizes. No authentication submission.',
  apkSha256: createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),
  runs: [], passed: false,
}
let owned = false
let restoreSwipeLock = false
const adb = (args, timeout = 30_000) => execFileSync('adb', ['-s', serial, ...args], {
  encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
})
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
const delay = () => new Promise(resolve => setTimeout(resolve, 500))
function deviceState() {
  const value = adb(['shell', 'cmd', 'device_state', 'print-state']).trim()
  if (!/^\d+$/.test(value)) throw new Error(`Unexpected committed device state: ${value}`)
  return Number(value)
}
async function changePosture(posture, expectedState) {
  const before = deviceState()
  const response = adb(['emu', posture]).trim()
  if (!/^OK$/m.test(response) || /^KO/m.test(response)) throw new Error(`Emulator ${posture} failed: ${response}`)
  const deadline = Date.now() + 20_000
  let lastState = before, observationError
  do {
    try {
      lastState = deviceState()
      observationError = undefined
      if (lastState !== before && (expectedState === undefined || lastState === expectedState)) {
        // Folding the disposable Pixel can lock its cover display. Wake the
        // current activity and dismiss only the OS keyguard on this no-PIN AVD.
        adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
        adb(['shell', 'wm', 'dismiss-keyguard'])
        return { before, after: lastState, command: posture }
      }
    } catch (error) { observationError = error.message }
    await delay()
  } while (Date.now() < deadline)
  throw new Error(observationError ?? `Device did not commit ${posture}: ${before} -> ${lastState}.`)
}
function captures(folder) {
  const names = ['retained-identifier.png', 'reachable-continue.png']
  const found = []
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (names.includes(entry.name)) {
        found.push({ name: entry.name, file: path.relative(output, file), ...screenshotDimensions(fs.readFileSync(file)) })
      }
    }
  }
  walk(folder)
  if (names.some(name => found.filter(image => image.name === name).length !== 1)) {
    throw new Error('Expected exactly one identifier and one reachable-action screenshot for this posture.')
  }
  if (found.some(image => image.width !== found[0].width || image.height !== found[0].height)) {
    throw new Error('Display geometry changed while verifying one posture.')
  }
  return found
}
function flow(folder, prepare) {
  fs.mkdirSync(folder, { recursive: true })
  const log = fs.openSync(path.join(folder, 'maestro.log'), 'w')
  let run
  try {
    run = spawnSync(maestro, [
      '--device', serial, 'test', '--format', 'junit', '--output', path.join(folder, 'report.xml'),
      '--test-output-dir', folder, '--debug-output', folder,
      path.resolve('.maestro-foldable', prepare ? 'prepare.yaml' : 'retained.yaml'),
    ], { stdio: ['ignore', log, log], timeout: prepare ? 180_000 : 120_000, env: process.env })
  } finally { fs.closeSync(log) }
  console.log(fs.readFileSync(path.join(folder, 'maestro.log'), 'utf8'))
  if (run.error || run.status !== 0) throw new Error(`Foldable native flow failed (${run.error?.code ?? run.status}).`)
  return {
    deviceState: deviceState(), displaySize: adb(['shell', 'wm', 'size']).trim(),
    displayDensity: adb(['shell', 'wm', 'density']).trim(), screenshots: captures(folder),
  }
}
const sameGeometry = (first, second) => first.screenshots[0].width === second.screenshots[0].width
  && first.screenshots[0].height === second.screenshots[0].height

async function main() {
  try {
    if (adb(['get-state']).trim() !== 'device' || adb(['shell', 'getprop', 'ro.kernel.qemu']).trim() !== '1') {
      throw new Error('Expected the disposable Android emulator.')
    }
    report.avd = adb(['emu', 'avd', 'name']).split(/\r?\n/)[0].trim()
    report.apiLevel = adb(['shell', 'getprop', 'ro.build.version.sdk']).trim()
    report.osVersion = adb(['shell', 'getprop', 'ro.build.version.release']).trim()
    report.pageSize = Number(adb(['shell', 'getconf', 'PAGE_SIZE']).trim())
    if (report.avd !== 'cyntch-foldable' || report.apiLevel !== report.expectedApiLevel || report.pageSize !== 16384) {
      throw new Error('Expected the owned API 37 foldable with 16 KB memory pages.')
    }
    owned = true
    // Switching the Pixel Fold's display can schedule the swipe lock after
    // wm dismiss-keyguard returns. This owned, disposable AVD has no PIN.
    // Remove only its swipe screen for the test; never clear a credential.
    const lock = () => adb(['shell', 'locksettings', 'get-disabled']).trim()
    const initial = lock()
    if (!['true', 'false'].includes(initial)) throw new Error('Cannot verify the fold test device’s lock setting.')
    if (initial === 'false') {
      restoreSwipeLock = true
      adb(['shell', 'locksettings', 'set-disabled', 'true'])
      if (lock() !== 'true') throw new Error('The disposable fold test device still has a lock screen.')
    }
    report.swipeLockDisabled = true
    adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
    adb(['shell', 'wm', 'dismiss-keyguard'])
    report.dataPartitionBeforeInstall = adb(['shell', 'df', '-k', '/data']).trim()
    report.memoryBeforeInstall = adb(['shell', 'cat', '/proc/meminfo']).split(/\r?\n/).filter(line => /^(MemTotal|MemAvailable|SwapFree):/.test(line))
    fs.writeFileSync(path.join(output, 'supported-device-states.txt'), adb(['shell', 'cmd', 'device_state', 'print-states']))
    adb(['install', '-r', apk], 120_000)
    adb(['logcat', '-c'])
    adb(['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
    adb(['shell', 'settings', 'put', 'system', 'user_rotation', '0'])

    // Establish a known folded baseline before entering any text. Require a
    // real state transition even if the AVD initially starts folded.
    const unfolded = adb(['emu', 'unfold']).trim()
    if (!/^OK$/m.test(unfolded) || /^KO/m.test(unfolded)) throw new Error('Could not initialise the foldable emulator.')
    // Only the initial setup may already be in the requested posture. Query
    // until the committed state settles before requesting the opposite posture.
    let stableState = deviceState(), stableReads = 0
    for (let attempt = 0; attempt < 40 && stableReads < 4; attempt++) {
      await delay()
      const next = deviceState()
      stableReads = next === stableState ? stableReads + 1 : 0
      stableState = next
    }
    if (stableReads < 4) throw new Error('The initial foldable device state did not settle.')
    report.initialFold = await changePosture('fold')
    const foldedState = report.initialFold.after
    for (const fontScale of [1, 1.6]) {
      const folder = path.join(output, fontScale === 1 ? 'default-text' : 'large-text')
      const result = { fontScale, passed: false }
      report.runs.push(result)
      save()
      try {
        // A failed posture case must not prevent the other text-size case, but
        // never restart/refill the form between the postures within a case.
        if (deviceState() !== foldedState) await changePosture('fold', foldedState)
        adb(['shell', 'settings', 'put', 'system', 'font_scale', String(fontScale)])
        if (Number(adb(['shell', 'settings', 'get', 'system', 'font_scale']).trim()) !== fontScale) {
          throw new Error('The requested system text scale was not applied.')
        }
        result.folded = flow(path.join(folder, 'folded'), true)
        if (result.folded.deviceState !== foldedState) throw new Error('The initial form is not on the folded display.')
        result.unfoldTransition = await changePosture('unfold')
        result.unfolded = flow(path.join(folder, 'unfolded'), false)
        if (result.unfolded.deviceState !== result.unfoldTransition.after || sameGeometry(result.folded, result.unfolded)) {
          throw new Error('Unfolding did not produce a distinct, stable app display geometry.')
        }
        result.refoldTransition = await changePosture('fold', foldedState)
        result.refolded = flow(path.join(folder, 'refolded'), false)
        if (result.refolded.deviceState !== foldedState || !sameGeometry(result.folded, result.refolded)) {
          throw new Error('Folding back did not restore the original display geometry.')
        }
        result.passed = true
      } catch (error) {
        result.error = error.message
        console.error(`Foldable text scale ${fontScale}: ${error.message}`)
      } finally { save() }
    }
    if (report.runs.some(result => !result.passed)) throw new Error('Foldable state retention failed at one or more text sizes.')
    report.passed = true
  } catch (error) {
    report.error = error.message
    console.error(error.message)
    process.exitCode = 1
  } finally {
    if (owned) {
      try { fs.writeFileSync(path.join(output, 'logcat.txt'), adb(['logcat', '-d', '-v', 'threadtime'])) } catch { /* Retain other evidence. */ }
      try {
        const remote = '/data/local/tmp/cyntch-foldable-ui.xml'
        adb(['shell', 'rm', '-f', remote])
        adb(['shell', 'uiautomator', 'dump', remote])
        fs.writeFileSync(path.join(output, 'last-hierarchy.xml'), adb(['shell', 'cat', remote]))
      } catch { /* A terminated emulator may no longer expose its hierarchy. */ }
      try {
        const bytes = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
        fs.writeFileSync(path.join(output, 'last-screen.png'), bytes)
      } catch { /* The flow logs and partial report remain. */ }
      if (restoreSwipeLock) {
        try {
          adb(['shell', 'locksettings', 'set-disabled', 'false'])
          report.swipeLockRestored = adb(['shell', 'locksettings', 'get-disabled']).trim() === 'false'
        } catch { report.swipeLockRestored = false }
        if (!report.swipeLockRestored) { report.passed = false; process.exitCode = 1 }
      }
    }
    save()
  }
}
main()
