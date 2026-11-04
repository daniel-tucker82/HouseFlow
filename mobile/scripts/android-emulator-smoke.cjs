// Signed-out verification on a disposable Actions emulator only. The action
// owns emulator startup/cleanup; no account or production API is used here.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { androidOrientationParameters, inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')

if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Run this verification on the Linux GitHub Actions host.')
}
if (process.argv.length !== 5) throw new Error('Expected APK, Maestro executable and output directory.')
const [apk, maestro, output] = process.argv.slice(2).map(value => path.resolve(value))
if (!fs.existsSync(apk) || !fs.existsSync(maestro)) throw new Error('Compiled APK and Maestro are required.')
fs.mkdirSync(output, { recursive: true })
const serial = 'emulator-5554'
const command = (executable, args, timeout = 60_000) => execFileSync(executable, args, {
  encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
})
const adb = (...args) => command('adb', ['-s', serial, ...args])
const report = {
  source: process.env.GITHUB_SHA,
  configuration: 'Release, minified, x86_64, development signing only',
  apkSha256: createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),
  serial,
  runs: [],
  passed: false,
}
try {
  if (adb('get-state').trim() !== 'device' || adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') {
    throw new Error('Expected the disposable Android emulator.')
  }
  report.model = adb('shell', 'getprop', 'ro.product.model').trim()
  report.apiLevel = adb('shell', 'getprop', 'ro.build.version.sdk').trim()
  report.osVersion = adb('shell', 'getprop', 'ro.build.version.release').trim()
  report.displaySize = adb('shell', 'wm', 'size').trim()
  report.displayDensity = adb('shell', 'wm', 'density').trim()
  report.orientations = androidOrientationParameters(report.displaySize)
  adb('install', '-r', apk)
  adb('logcat', '-c')
  for (const fontScale of [1, 1.6]) {
    const folder = path.join(output, fontScale === 1 ? 'default-text' : 'large-text')
    fs.mkdirSync(folder, { recursive: true })
    const result = { fontScale, passed: false }
    report.runs.push(result)
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
    try {
      // This is the disposable emulator verified above, not the user's device.
      adb('shell', 'settings', 'put', 'system', 'font_scale', String(fontScale))
      const actual = Number(adb('shell', 'settings', 'get', 'system', 'font_scale').trim())
      if (actual !== fontScale) throw new Error('The requested system text scale was not applied.')
      const log = fs.openSync(path.join(folder, 'maestro.log'), 'w')
      let run
      try {
        run = spawnSync(maestro, [
          '--device', serial, 'test', '--format', 'junit', '--output', path.join(folder, 'report.xml'),
          '-e', `PORTRAIT_ORIENTATION=${report.orientations.portrait}`,
          '-e', `LANDSCAPE_ORIENTATION=${report.orientations.landscape}`,
          '--test-output-dir', folder, '--debug-output', folder, path.resolve('.maestro'),
        ], { stdio: ['ignore', log, log], timeout: 300_000, env: process.env })
      } finally { fs.closeSync(log) }
      console.log(fs.readFileSync(path.join(folder, 'maestro.log'), 'utf8'))
      result.exitCode = run.status
      result.orientationEvidence = inspectScreenshotOrientations(folder, {
        'native-social-sign-in-portrait.png': 'portrait',
        'native-social-sign-in-landscape.png': 'landscape',
        'welcome-after-dismiss-landscape.png': 'landscape',
        'native-keyboard-portrait.png': 'portrait',
        'native-keyboard-landscape.png': 'landscape',
        'native-keyboard-dismissed-landscape.png': 'landscape',
        'welcome-after-back-portrait.png': 'portrait',
      })
      if (run.error || run.status !== 0) throw new Error(`Android flow failed (${run.error?.code ?? run.status}).`)
      if (!result.orientationEvidence.passed) throw new Error('Screenshots do not prove both requested orientations.')
      result.passed = true
    } catch (error) {
      result.error = error.message
      console.error(`Text scale ${fontScale}: ${error.message}`)
    }
  }
  if (report.runs.some(result => !result.passed)) throw new Error('Android native flow failed at one or more text sizes.')
  report.passed = true
} catch (error) {
  report.error = error.message
  console.error(error.message)
  process.exitCode = 1
} finally {
  try { fs.writeFileSync(path.join(output, 'logcat.txt'), adb('logcat', '-d', '-v', 'threadtime')) }
  catch { /* The flow log/result remain available if the emulator stopped. */ }
  try {
    const screenshot = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
      timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
    })
    fs.writeFileSync(path.join(output, 'last-screen.png'), screenshot)
  } catch { /* The emulator may not have booted successfully. */ }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
}
