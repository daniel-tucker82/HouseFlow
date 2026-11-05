// Verification on a disposable Actions emulator only. Default flows stay signed
// out; explicit fixture inputs add development-only sign-in and household checks.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { androidOrientationParameters, inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')
const { authFixture, runAuthenticatedSmoke } = require('./native-auth-smoke.cjs')
const { runKioskSmoke } = require('./native-kiosk-smoke.cjs')
const { runOfflineSmoke } = require('./android-offline-smoke.cjs')
const { runNotificationPreferencesSmoke } = require('./native-notification-preferences-smoke.cjs')

if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Run this verification on the Linux GitHub Actions host.')
}
if (process.argv.length !== 5) throw new Error('Expected APK, Maestro executable and output directory.')
const [apk, maestro, output] = process.argv.slice(2).map(value => path.resolve(value))
const fixture = authFixture()
const offlineOnly = process.env.CYNTCH_ANDROID_OFFLINE === 'true'
if (offlineOnly && (!fixture || !/^[a-f0-9]{40}$/.test(process.env.CYNTCH_ANDROID_APP_SHA ?? ''))) throw new Error('Offline verification requires the verified APK and isolated sign-in fixture.')
if (!fs.existsSync(apk) || !fs.existsSync(maestro)) throw new Error('Compiled APK and Maestro are required.')
fs.mkdirSync(output, { recursive: true })
const serial = 'emulator-5554'
const command = (executable, args, timeout = 60_000) => execFileSync(executable, args, {
  encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
})
const adb = (...args) => command('adb', ['-s', serial, ...args])
const report = {
  source: process.env.CYNTCH_ANDROID_APP_SHA || process.env.GITHUB_SHA,
  verificationSource: process.env.GITHUB_SHA,
  configuration: 'Release, minified, x86_64, development signing only',
  apkSha256: createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),
  serial,
  runs: [],
  passed: false,
}
let owned = false
try {
  if (adb('get-state').trim() !== 'device' || adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') {
    throw new Error('Expected the disposable Android emulator.')
  }
  report.model = adb('shell', 'getprop', 'ro.product.model').trim()
  report.apiLevel = adb('shell', 'getprop', 'ro.build.version.sdk').trim()
  report.osVersion = adb('shell', 'getprop', 'ro.build.version.release').trim()
  report.avd = adb('emu', 'avd', 'name').split(/\r?\n/)[0].trim()
  report.pageSize = Number(adb('shell', 'getconf', 'PAGE_SIZE').trim())
  if (!['cyntch-phone', 'cyntch-tablet'].includes(report.avd) || report.apiLevel !== '37' || report.pageSize !== 16384) {
    throw new Error('Expected the owned API 37 phone or tablet with 16 KB memory pages.')
  }
  owned = true
  report.dataPartitionBeforeInstall = adb('shell', 'df', '-k', '/data').trim()
  report.memoryBeforeInstall = adb('shell', 'cat', '/proc/meminfo').split(/\r?\n/).filter(line => /^(MemTotal|MemAvailable|SwapFree):/.test(line))
  report.displaySize = adb('shell', 'wm', 'size').trim()
  report.displayDensity = adb('shell', 'wm', 'density').trim()
  report.orientations = androidOrientationParameters(report.displaySize)
  const install = command('adb', ['-s', serial, 'install', '--no-streaming', '-r', apk], 120_000)
  if (!/^Success$/m.test(install.trim()) || !adb('shell', 'pm', 'path', 'com.cyntch.app').includes('package:')) {
    throw new Error('Cyntch installation was not acknowledged on the owned emulator.')
  }
  adb('logcat', '-c')
  for (const fontScale of (offlineOnly ? [] : [1, 1.6])) {
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
  if (fixture) {
    adb('shell', 'settings', 'put', 'system', 'font_scale', '1')
    if (Number(adb('shell', 'settings', 'get', 'system', 'font_scale').trim()) !== 1) throw new Error('Default text size was not restored for authenticated verification.')
    report.authentication = runAuthenticatedSmoke({ maestro, device: serial, output: path.join(output, 'authenticated'), orientations: report.orientations, fixture })
  }
  if (report.authentication && !report.authentication.passed) throw new Error(report.authentication.error)
  if (offlineOnly && report.authentication?.passed) {
    if (report.avd !== 'cyntch-phone') throw new Error('Offline replay requires the phone fixture.')
    report.offline = runOfflineSmoke({ maestro, device: serial, output: path.join(output, 'offline'), orientations: report.orientations })
    if (!report.offline.passed) throw new Error(report.offline.error)
  }
  if (report.authentication?.passed && report.avd === 'cyntch-tablet') {
    report.kiosk = runKioskSmoke({ maestro, device: serial, output: path.join(output, 'kiosk'), orientations: report.orientations })
    if (!report.kiosk.passed) throw new Error(report.kiosk.error)
  }
  if (!offlineOnly && report.authentication?.passed && report.avd === 'cyntch-phone') {
    const folder=path.join(output,'notifications')
    fs.mkdirSync(folder,{recursive:true})
    const log=fs.openSync(path.join(folder,'maestro.log'),'w')
    let run
    try {
      run=spawnSync(maestro,['--device',serial,'test','--format','junit','--output',path.join(folder,'report.xml'),
        '-e','PORTRAIT_ORIENTATION='+report.orientations.portrait,'--test-output-dir',folder,'--debug-output',folder,
        path.resolve('.maestro-android-notifications/permission.yaml')],{stdio:['ignore',log,log],timeout:240000,env:process.env})
    } finally { fs.closeSync(log) }
    const permission=adb('shell','dumpsys','package','com.cyntch.app')
    const screen=adb('shell','dumpsys','activity','activities')
    fs.writeFileSync(path.join(folder,'settings-activity.txt'),screen)
    report.notifications={flow:run.status===0&&!run.error,
      granted:/android\.permission\.POST_NOTIFICATIONS:\s*granted=true/.test(permission),
      systemSettings:/(?:topResumedActivity|mResumedActivity)[^\n]*com\.android\.settings\//.test(screen),
      screenshots:inspectScreenshotOrientations(folder,{'android-notification-permission.png':'portrait',
        'android-notifications-granted.png':'portrait','android-notification-settings.png':'portrait'},{includeStartup:false})}
    if (!report.notifications.flow || !report.notifications.granted || !report.notifications.systemSettings || !report.notifications.screenshots.passed) {
      throw new Error('Android notification authorization or system settings verification failed.')
    }
    report.notificationPreferences = runNotificationPreferencesSmoke({ maestro, device: serial,
      output: path.join(output, 'notification-preferences'), orientations: report.orientations })
    if (!report.notificationPreferences.passed) throw new Error(report.notificationPreferences.error)
  }
  if (report.runs.some(result => !result.passed)) throw new Error('Android native flow failed at one or more text sizes.')
  report.passed = true
} catch (error) {
  report.error = error.message
  console.error(error.message)
  process.exitCode = 1
} finally {
  try { if (owned) fs.writeFileSync(path.join(output, 'logcat.txt'), adb('logcat', '-d', '-v', 'threadtime')) }
  catch { /* The flow log/result remain available if the emulator stopped. */ }
  try {
    if (owned) {
      const screenshot = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
        timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
      })
      fs.writeFileSync(path.join(output, 'last-screen.png'), screenshot)
    }
  } catch { /* The emulator may not have booted successfully. */ }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
}
