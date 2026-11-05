// Device/session-specific app-lock checks on the already authenticated test
// tablet. Never clear its data to pass a restart or remove a lock on failure.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { authFixture } = require('./native-auth-smoke.cjs')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')

function runKioskSmoke({ maestro, device, output, orientations }) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !authFixture()) throw new Error('Kiosk verification requires the isolated authenticated Actions fixture.')
  fs.mkdirSync(output, { recursive: true })
  const result = { source: process.env.CYNTCH_IOS_APP_SHA || process.env.GITHUB_SHA,
    scope: 'Tablet app lock, rotation, restart, blocked settings link, incorrect/correct PIN and acknowledged unlock.', passed: false }
  const log = fs.openSync(path.join(output, 'maestro.log'), 'w')
  try {
    const run = spawnSync(maestro, ['--device', device, 'test', '--format', 'junit', '--output', path.join(output, 'report.xml'),
      '-e', `PORTRAIT_ORIENTATION=${orientations.portrait}`, '-e', `LANDSCAPE_ORIENTATION=${orientations.landscape}`,
      '--test-output-dir', output, '--debug-output', output, path.resolve('.maestro-kiosk/lock.yaml')],
    { stdio: ['ignore', log, log], timeout: 480_000, env: process.env })
    result.exitCode = run.status
    result.screenshots = inspectScreenshotOrientations(output, {
      'kiosk-locked-portrait.png': 'portrait', 'kiosk-locked-landscape.png': 'landscape',
      'kiosk-locked-after-restart.png': 'portrait', 'kiosk-blocked-settings-link.png': 'portrait',
      'kiosk-incorrect-pin.png': 'portrait', 'kiosk-parent-restored.png': 'portrait',
      'kiosk-parent-after-restart.png': 'portrait',
    }, { includeStartup: false })
    if (run.error || run.status !== 0) throw new Error(`Kiosk native flow failed (${run.error?.code ?? run.status}).`)
    if (!result.screenshots.passed) throw new Error('Kiosk screenshots do not prove rotation, restart and parent access.')
    result.passed = true
  } catch (error) { result.error = error.message }
  finally {
    fs.closeSync(log)
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log(fs.readFileSync(path.join(output, 'maestro.log'), 'utf8'))
  }
  return result
}
module.exports = { runKioskSmoke }
