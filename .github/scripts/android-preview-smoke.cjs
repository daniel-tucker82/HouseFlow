// Run only on a new, owned cloud emulator. No household edits or sign-in.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const expected = require('../fixtures/android-preview.json')
const { inspectScreenshotOrientations, androidOrientationParameters } = require('../../mobile/scripts/device-screenshot-evidence.cjs')
if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'daniel-tucker82/HouseFlow') throw Error('This check requires the owned GitHub Actions runner.')
const [apk, maestro, output] = process.argv.slice(2).map(value => path.resolve(value))
if (!apk || !maestro || !output) throw Error('Expected APK, Maestro and evidence directory.')
fs.mkdirSync(output, { recursive: true })
const adb = (...args) => execFileSync('adb', ['-s', 'emulator-5554', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 24 * 1024 * 1024 })
const report = { buildId: expected.buildId, appSource: expected.source, verificationSource: process.env.GITHUB_SHA,
  scope: 'Exact EAS-signed APK: fresh install, signed-out startup, native sign-in form, rotation and restart. No authenticated edits or push delivery.', passed: false }
let owned = false
try {
  report.sha256 = createHash('sha256').update(fs.readFileSync(apk)).digest('hex')
  const artifact = JSON.parse(fs.readFileSync(path.join(output, 'artifact.json'), 'utf8'))
  if (report.sha256 !== expected.sha256 || !artifact.passed || artifact.sha256 !== expected.sha256) throw Error('Static artifact checks must pass for this exact APK.')
  if (adb('get-state').trim() !== 'device' || adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1'
    || adb('emu', 'avd', 'name').split(/\r?\n/)[0].trim() !== 'cyntch-eas-preview'
    || adb('shell', 'getprop', 'ro.build.version.sdk').trim() !== '36') throw Error('Expected the new owned API 36 emulator.')
  owned = true
  if (adb('shell', 'pm', 'list', 'packages', 'com.cyntch.app').trim()) throw Error('Refuse to replace an existing app or its data.')
  const install = execFileSync('adb', ['-s', 'emulator-5554', 'install', '--no-streaming', apk], { encoding: 'utf8', timeout: 120000 })
  if (!/^Success$/m.test(install.trim())) throw Error('Installation was not acknowledged.')
  report.installed = true
  adb('logcat', '-c')
  report.orientations = androidOrientationParameters(adb('shell', 'wm', 'size'))
  const log = fs.openSync(path.join(output, 'maestro.log'), 'w')
  let result
  try {
    result = spawnSync(maestro, ['--device', 'emulator-5554', 'test', '--format', 'junit', '--output', path.join(output, 'junit.xml'),
      '-e', 'PORTRAIT_ORIENTATION=' + report.orientations.portrait, '-e', 'LANDSCAPE_ORIENTATION=' + report.orientations.landscape,
      '--test-output-dir', output, '--debug-output', output, '.maestro/signed-out.yaml'],
    { cwd: path.resolve(__dirname, '../../mobile'), stdio: ['ignore', log, log], timeout: 360000, env: process.env })
  } finally { fs.closeSync(log) }
  report.exitCode = result.status
  if (result.error || result.status !== 0) throw Error('Signed preview journey failed: ' + (result.error?.code ?? result.status))
  report.screenshots = inspectScreenshotOrientations(output, {
    'native-social-sign-in-portrait.png': 'portrait', 'native-social-sign-in-landscape.png': 'landscape',
    'welcome-after-dismiss-landscape.png': 'landscape',
  })
  if (!report.screenshots.passed) throw Error('Required screenshots or orientations are missing.')
  report.crashBuffer = adb('logcat', '-b', 'crash', '-d', '-v', 'threadtime')
  if (/Process:\s*com\.cyntch\.app\b/.test(report.crashBuffer) || /ANR in com\.cyntch\.app\b/.test(adb('logcat', '-d'))) throw Error('Cyntch crash or ANR detected.')
  report.passed = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  if (owned) {
    try { fs.writeFileSync(path.join(output, 'logcat.txt'), adb('logcat', '-d', '-v', 'threadtime')) } catch { /* Earlier evidence remains. */ }
    try { fs.writeFileSync(path.join(output, 'last-screen.png'), execFileSync('adb', ['-s', 'emulator-5554', 'exec-out', 'screencap', '-p'], { timeout: 15000 })) } catch { /* Earlier evidence remains. */ }
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, installed: report.installed, error: report.error }))
}
