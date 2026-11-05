const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { authFixture } = require('./native-auth-smoke.cjs')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')
const { runIOSUI } = require('../../.github/scripts/ios-device-process.cjs')

function runNotificationPreferencesSmoke({ maestro, device, output, orientations }) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !authFixture() || !['linux', 'darwin'].includes(process.platform)) {
    throw new Error('Notification preference verification requires the isolated authenticated Actions fixture.')
  }
  fs.mkdirSync(output, { recursive: true })
  const result = { source: process.env.CYNTCH_ANDROID_APP_SHA || process.env.CYNTCH_IOS_APP_SHA || process.env.GITHUB_SHA,
    verificationSource: process.env.GITHUB_SHA,
    scope: 'Per-event/member choices, portrait/landscape, restart and UI acknowledgement; no provider-delivery claim.', passed: false }
  const log = fs.openSync(path.join(output, 'maestro.log'), 'w')
  try {
    const execute = process.platform === 'darwin' ? runIOSUI : spawnSync
    const run = execute(maestro, ['--device', device, 'test', '--format', 'junit', '--output', path.join(output, 'report.xml'),
      '-e', `PORTRAIT_ORIENTATION=${orientations.portrait}`, '-e', `LANDSCAPE_ORIENTATION=${orientations.landscape}`,
      '--test-output-dir', output, '--debug-output', output, path.resolve('.maestro-notification-preferences/settings.yaml')],
    { stdio: ['ignore', log, log], timeout: 480_000, env: process.env })
    result.exitCode = run.status
    result.driverCleanup = run.driverCleanup
    result.screenshots = inspectScreenshotOrientations(output, {
      'notification-member-choices-portrait.png': 'portrait', 'notification-member-choices-landscape.png': 'landscape',
      'notification-household-events-portrait.png': 'portrait', 'notification-member-choices-after-restart.png': 'portrait',
      'notification-household-events-after-restart.png': 'portrait', 'notification-choices-synced.png': 'portrait',
    }, { includeStartup: false })
    if (run.error || run.status !== 0) throw new Error(`Notification preferences flow failed (${run.error?.code ?? run.status}).`)
    if (!result.screenshots.passed) throw new Error('Notification choices lack the required orientation/restart captures.')
    result.passed = true
  } catch (error) { result.error = error.message }
  finally {
    fs.closeSync(log)
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log(fs.readFileSync(path.join(output, 'maestro.log'), 'utf8'))
  }
  return result
}
module.exports = { runNotificationPreferencesSmoke }
