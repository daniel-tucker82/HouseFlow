// Reuses the exact signed APK on a fresh owned cloud emulator. A separately
// bounded local sender targets only this newly registered test installation.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { authFixture, runAuthenticatedSmoke } = require('../../mobile/scripts/native-auth-smoke.cjs')
const { androidOrientationParameters, inspectScreenshotOrientations } = require('../../mobile/scripts/device-screenshot-evidence.cjs')
const expected = require('../fixtures/android-preview.json')
const body = 'Android push verification 27c85274d.'
if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true'
  || process.env.GITHUB_REPOSITORY !== 'daniel-tucker82/HouseFlow'
  || process.env.GITHUB_REF_NAME !== 'codex/native-android-push-verification') throw Error('Requires the isolated owned Actions branch.')
const [apkInput, maestroInput, outputInput] = process.argv.slice(2)
if (!apkInput || !maestroInput || !outputInput) throw Error('Expected APK, Maestro and output directory.')
const [apk, maestro, output] = [apkInput, maestroInput, outputInput].map(value => path.resolve(value))
const root = path.resolve(__dirname, '../..')
fs.mkdirSync(output, { recursive: true })
const adb = (...args) => execFileSync('adb', ['-s', 'emulator-5554', ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 24 * 1024 * 1024 })
const report = { source: expected.source, verificationSource: process.env.GITHUB_SHA, buildId: expected.buildId,
  scope: 'Real FCM delivery to one new test emulator: system permission, notification pane and tap. No household edits; provider receipt is separate local evidence.', passed: false }
const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
// Full-resolution launcher screenshots can exceed Node's default 1 MiB buffer.
// Match the bounded allowance used by the other Android device harnesses.
const capture = name => fs.writeFileSync(path.join(output, name + '.png'), execFileSync('adb', ['-s', 'emulator-5554', 'exec-out', 'screencap', '-p'], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }))
function flow(name) {
  const directory = path.join(output, name)
  fs.mkdirSync(directory, { recursive: true })
  const log = fs.openSync(path.join(directory, 'maestro.log'), 'w')
  try {
    const run = spawnSync(maestro, ['--device', 'emulator-5554', 'test', '--format', 'junit', '--output', path.join(directory, 'report.xml'),
      '--test-output-dir', directory, '--debug-output', directory, path.join(root, '.github/flows/' + name + '.yaml')],
    { cwd: root, stdio: ['ignore', log, log], timeout: 240000 })
    if (run.error || run.status !== 0) throw Error('Android push ' + name + ' failed (' + (run.error?.code ?? run.status) + ').')
  } finally { fs.closeSync(log) }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
;(async () => {
  let owned = false
  try {
    const artifact = JSON.parse(fs.readFileSync(path.join(output, 'artifact.json'), 'utf8'))
    if (!artifact.passed || artifact.sha256 !== expected.sha256
      || createHash('sha256').update(fs.readFileSync(apk)).digest('hex') !== expected.sha256) throw Error('Exact signed APK checks must pass.')
    const fixture = authFixture()
    if (fixture?.origin !== expected.fixtureUrl || fixture.email !== 'cyntch-native-20261103+clerk_test@example.com') throw Error('Only the existing isolated fixture is allowed.')
    if (adb('get-state').trim() !== 'device' || adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1'
      || adb('emu', 'avd', 'name').split(/\r?\n/)[0].trim() !== 'cyntch-android-push'
      || adb('shell', 'getprop', 'ro.build.version.sdk').trim() !== '36'
      || !adb('shell', 'pm', 'list', 'packages', 'com.google.android.gms').includes('package:com.google.android.gms')) throw Error('Expected the fresh API 36 Google Play services emulator.')
    if (adb('shell', 'pm', 'list', 'packages', 'com.cyntch.app').trim()) throw Error('Refuse to replace an existing installation.')
    owned = true
    const install = execFileSync('adb', ['-s', 'emulator-5554', 'install', '--no-streaming', apk], { encoding: 'utf8', timeout: 120000 })
    if (!/^Success$/m.test(install.trim())) throw Error('Installation not acknowledged.')
    report.installed = true
    adb('logcat', '-c')
    const orientations = androidOrientationParameters(adb('shell', 'wm', 'size'))
    process.env.CYNTCH_ANDROID_APP_SHA = expected.source
    process.chdir(path.join(root, 'mobile'))
    report.authentication = runAuthenticatedSmoke({ maestro, device: 'emulator-5554', output: path.join(output, 'authentication'), orientations, fixture, verifySessionJourney: false })
    if (!report.authentication.passed) throw Error('Focused sign-in setup failed; inspect authentication evidence.')
    // The standard auth fixture denies permissions. Reset only this fresh app's
    // notification decision so the actual Android permission prompt is tested.
    adb('shell', 'pm', 'revoke', 'com.cyntch.app', 'android.permission.POST_NOTIFICATIONS')
    adb('shell', 'pm', 'clear-permission-flags', 'com.cyntch.app', 'android.permission.POST_NOTIFICATIONS', 'user-set')
    adb('shell', 'pm', 'clear-permission-flags', 'com.cyntch.app', 'android.permission.POST_NOTIFICATIONS', 'user-fixed')
    if (/android\.permission\.POST_NOTIFICATIONS: granted=true/.test(adb('shell', 'dumpsys', 'package', 'com.cyntch.app'))) throw Error('Notification permission must initially be denied.')
    flow('android-push-permission')
    report.permissionGranted = /android\.permission\.POST_NOTIFICATIONS: granted=true/.test(adb('shell', 'dumpsys', 'package', 'com.cyntch.app'))
    if (!report.permissionGranted) throw Error('OS notification permission was not granted.')
    report.readyAt = new Date().toISOString()
    save()
    console.log('Ready for the single bounded test notification at ' + report.readyAt)
    const deadline = Date.now() + 8 * 60000
    while (Date.now() < deadline) {
      const notifications = adb('shell', 'dumpsys', 'notification', '--noredact')
      if (notifications.includes(body)) {
        report.systemNotificationAt = new Date().toISOString()
        // Save only this test notification's descriptive lines, never device
        // push tokens or unrelated notification payloads.
        fs.writeFileSync(path.join(output, 'system-notification.txt'), notifications.split(/\r?\n/)
          .filter(line => line.includes(body) || /NotificationRecord\(.*com\.cyntch\.app/.test(line)).join('\n'))
        // A failed image capture must not discard the chance to inspect and tap
        // the already-delivered notification. The required-image check below
        // still fails the journey if this capture is missing.
        try { capture('android-push-banner-candidate') } catch (error) { report.bannerCaptureError = error.message }
        save()
        break
      }
      await pause(750)
    }
    if (!report.systemNotificationAt) throw Error('No actual provider notification arrived within the bounded wait; do not resend automatically.')
    adb('shell', 'cmd', 'statusbar', 'expand-notifications')
    flow('android-push-open')
    report.screenshots = inspectScreenshotOrientations(output, {
      'android-push-before-permission.png': 'portrait', 'android-push-system-prompt.png': 'portrait',
      'android-push-permission-granted.png': 'portrait', 'android-push-background-before-send.png': 'portrait',
      'android-push-registration-confirmed.png': 'portrait',
      'android-push-notification-pane.png': 'portrait', 'android-push-opened-task.png': 'portrait',
      'android-push-banner-candidate.png': 'portrait',
    }, { includeStartup: false })
    if (!report.screenshots.passed) throw Error('Required notification evidence is incomplete.')
    report.bannerNeedsVisualInspection = true
    if (/Process:\s*com\.cyntch\.app\b/.test(adb('logcat', '-b', 'crash', '-d'))
      || /ANR in com\.cyntch\.app\b/.test(adb('logcat', '-d'))) throw Error('Cyntch crash or ANR detected.')
    report.passed = true
  } catch (error) { report.error = error.message; process.exitCode = 1 }
  finally {
    if (owned) {
      try { capture('android-push-last-screen') } catch { /* Preserve earlier evidence. */ }
      try { fs.writeFileSync(path.join(output, 'logcat.txt'), adb('logcat', '-d', '-v', 'threadtime')
        .replace(/(?:ExponentPushToken|ExpoPushToken)\[[^\]]+\]/g, '[REDACTED_PUSH_TOKEN]')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')) } catch { /* Preserve earlier evidence. */ }
    }
    save()
    console.log(JSON.stringify({ passed: report.passed, permissionGranted: report.permissionGranted, systemNotificationAt: report.systemNotificationAt, error: report.error }))
  }
})()
