// Check the declared Android 7/API 24 floor on an owned CI emulator. Use the
// platform UIAutomator dump/input tools: the modern Maestro driver is not our
// compatibility oracle for this old OS. No credentials or permissions are sent.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')

if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Run this verification on the Linux GitHub Actions host.')
}
if (process.argv.length !== 4) throw new Error('Expected APK and output directory.')
const [apk, output] = process.argv.slice(2).map(value => path.resolve(value))
if (!fs.existsSync(apk)) throw new Error('Compiled APK is required.')
fs.mkdirSync(output, { recursive: true })
const serial = 'emulator-5554', appId = 'com.cyntch.app'
const report = {
  source: process.env.GITHUB_SHA, serial, expectedApiLevel: '24',
  configuration: 'Release, minified, x86_64, development signing only',
  scope: 'Install, signed-out startup, native email form, rotation, force-stop/relaunch. No authenticated workflows.',
  apkSha256: createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),
  stages: [], passed: false,
}
let owned = false, currentSize
const adbCommand = (args, timeout = 30_000) => execFileSync('adb', ['-s', serial, ...args], {
  encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
})
const adb = (...args) => adbCommand(args)
const sleep = () => new Promise(resolve => setTimeout(resolve, 750))
const stage = name => {
  report.stages.push({ name, at: new Date().toISOString() })
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
  console.log(name)
}
function screenshot(name) {
  const bytes = execFileSync('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
    timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
  })
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Expected a device PNG screenshot.')
  }
  currentSize = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  fs.writeFileSync(path.join(output, `${name}.png`), bytes)
  return currentSize
}
function hierarchy() {
  const remote = '/data/local/tmp/cyntch-minimum-ui.xml'
  // Never inspect a stale dump if the current UIAutomator call failed.
  adb('shell', 'rm', '-f', remote)
  adb('shell', 'uiautomator', 'dump', remote)
  const xml = adb('shell', 'cat', remote)
  fs.writeFileSync(path.join(output, 'last-hierarchy.xml'), xml)
  if (!xml.includes('<hierarchy')) throw new Error('UIAutomator did not return a hierarchy.')
  // Read the attributes of UIAutomator-generated node tags. Text/entity values
  // are decoded only for matching these fixed, English signed-out labels.
  const decode = value => value.replace(/&(quot|apos|lt|gt|amp);/g, (_, entity) =>
    ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[entity])
  return [...xml.matchAll(/<node\b[^>]*>/g)].map(([tag]) =>
    Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)])))
}
function bounds(node) {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(node.bounds ?? '')
  if (!match) return null
  const [left, top, right, bottom] = match.slice(1).map(Number)
  return right > left && bottom > top && left >= 0 && top >= 0 &&
    right <= currentSize.width && bottom <= currentSize.height ? { left, top, right, bottom } : null
}
const labelIs = label => node => node.text === label || node['content-desc'] === label
async function findNode(predicate, scroll = false) {
  const deadline = Date.now() + (scroll ? 30_000 : 60_000)
  let swipes = 0, lastDumpError
  while (Date.now() < deadline) {
    let nodes
    try { nodes = hierarchy(); lastDumpError = undefined }
    catch (error) {
      // A fresh launch can still be drawing. Retry this same device and stage;
      // a transient observation failure must not restart or clear the app.
      lastDumpError = error.message
      await sleep()
      continue
    }
    const found = nodes.find(node => node.package === appId && predicate(node) && bounds(node))
    if (found) return found
    if (scroll && swipes++ < 8) {
      // The auth body occupies the middle of the landscape display. Start
      // inside it, rather than on the fixed top bar or development footer.
      const x = Math.round(currentSize.width / 2)
      adb('shell', 'input', 'swipe', String(x), String(Math.round(currentSize.height * 0.6)),
        String(x), String(Math.round(currentSize.height * 0.3)), '500')
    }
    await sleep()
  }
  throw new Error(lastDumpError ?? `Expected app control was not reachable${scroll ? ' after scrolling' : ''}.`)
}
async function rotate(landscape) {
  adb('shell', 'settings', 'put', 'system', 'user_rotation', landscape ? '1' : '0')
  const deadline = Date.now() + 15_000
  do {
    const size = screenshot('rotation-check')
    if (landscape ? size.width > size.height : size.height > size.width) { await sleep(); return }
    await sleep()
  } while (Date.now() < deadline)
  throw new Error('The requested display orientation was not applied.')
}
function launch() {
  const result = adb('shell', 'am', 'start', '-W', '-n', `${appId}/.MainActivity`)
  if (/Error:|Exception|Status:\s*(?!ok\b)\S+/i.test(result)) throw new Error(`App launch failed: ${result}`)
}
async function main() {
  try {
    if (adb('get-state').trim() !== 'device' || adb('shell', 'getprop', 'ro.kernel.qemu').trim() !== '1') {
      throw new Error('Expected the disposable Android emulator.')
    }
    report.apiLevel = adb('shell', 'getprop', 'ro.build.version.sdk').trim()
    if (report.apiLevel !== report.expectedApiLevel) throw new Error('Expected the API 24 compatibility emulator.')
    owned = true
    report.osVersion = adb('shell', 'getprop', 'ro.build.version.release').trim()
    report.displaySize = adb('shell', 'wm', 'size').trim()
    report.displayDensity = adb('shell', 'wm', 'density').trim()
    stage('install')
    // Installing the optimized APK can exceed a normal shell command's budget
    // on the old emulator. Observe this one install; never relaunch it on timeout.
    if (!/Success/.test(adbCommand(['install', '-r', apk], 120_000))) throw new Error('APK installation was not acknowledged.')
    adb('logcat', '-c')
    adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0')
    adb('shell', 'settings', 'put', 'system', 'font_scale', '1.0')
    stage('welcome-portrait')
    await rotate(false)
    launch()
    await findNode(labelIs('Sign in or create an account'))
    await findNode(labelIs('A little more together.'))
    screenshot('welcome-portrait')
    stage('welcome-landscape')
    await rotate(true)
    await findNode(labelIs('Sign in or create an account'))
    screenshot('welcome-landscape')
    stage('native-sign-in-portrait')
    await rotate(false)
    const entry = bounds(await findNode(labelIs('Sign in or create an account')))
    adb('shell', 'input', 'tap', String(Math.round((entry.left + entry.right) / 2)),
      String(Math.round((entry.top + entry.bottom) / 2)))
    await findNode(node => node['resource-id'] === 'clerk.auth.start.identifier')
    await findNode(labelIs('Continue'), true)
    screenshot('native-sign-in-portrait')
    stage('native-sign-in-landscape')
    await rotate(true)
    await findNode(labelIs('Continue'), true)
    screenshot('native-sign-in-landscape')
    stage('dismiss-native-sign-in')
    const close = bounds(await findNode(labelIs('Close')))
    report.dismissControlBounds = close
    fs.writeFileSync(path.join(output, 'native-sign-in-landscape.xml'), fs.readFileSync(path.join(output, 'last-hierarchy.xml')))
    adb('shell', 'input', 'tap', String(Math.round((close.left + close.right) / 2)),
      String(Math.round((close.top + close.bottom) / 2)))
    await findNode(labelIs('Sign in or create an account'))
    screenshot('welcome-after-dismiss-landscape')
    // Reopen before force-stop so restart coverage still begins in native auth.
    const reopen = bounds(await findNode(labelIs('Sign in or create an account')))
    adb('shell', 'input', 'tap', String(Math.round((reopen.left + reopen.right) / 2)),
      String(Math.round((reopen.top + reopen.bottom) / 2)))
    await findNode(node => node['resource-id'] === 'clerk.auth.start.identifier')
    stage('force-stop-and-relaunch')
    await rotate(false)
    adb('shell', 'am', 'force-stop', appId)
    launch()
    await findNode(labelIs('Sign in or create an account'))
    screenshot('welcome-after-restart')
    report.orientationEvidence = inspectScreenshotOrientations(output, {
      'welcome-after-dismiss-landscape.png': 'landscape',
    })
    if (!report.orientationEvidence.passed) throw new Error('Missing or incorrect screenshot orientations.')
    report.passed = true
    stage('completed')
  } catch (error) {
    report.error = error.message
    console.error(error.message)
    process.exitCode = 1
  } finally {
    if (owned) {
      try { screenshot('last-screen') } catch { /* Preserve earlier evidence. */ }
      try { fs.writeFileSync(path.join(output, 'logcat.txt'), adb('logcat', '-d', '-v', 'threadtime')) } catch { /* Emulator may have stopped. */ }
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
