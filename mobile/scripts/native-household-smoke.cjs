const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { authFixture } = require('./native-auth-smoke.cjs')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')
const { runIOSUI } = require('../../.github/scripts/ios-device-process.cjs')

function householdFixture(env = process.env) {
  const fixture = authFixture(env)
  if (env.CYNTCH_NATIVE_HOUSEHOLD_CHECK !== 'true' || !fixture || fixture.email !== 'cyntch-native-20261103+clerk_test@example.com') {
    throw new Error('Member editing verification requires the explicitly selected isolated parent fixture.')
  }
  return fixture
}

function runHouseholdSmoke({ maestro, device, output, orientations }) {
  householdFixture()
  if (process.env.GITHUB_ACTIONS !== 'true' || !['linux', 'darwin'].includes(process.platform)) throw new Error('Use an owned Actions emulator or simulator.')
  fs.mkdirSync(output, { recursive: true })
  const result = { source: process.env.CYNTCH_ANDROID_APP_SHA || process.env.CYNTCH_IOS_APP_SHA || process.env.GITHUB_SHA,
    verificationSource: process.env.GITHUB_SHA, scope: 'Dedicated no-email member: add, cancelled rename, saved rename/colour, rotation, restart, board and removal.', passed: false }
  const log = fs.openSync(path.join(output, 'maestro.log'), 'w')
  try {
    const execute = process.platform === 'darwin' ? runIOSUI : spawnSync
    const run = execute(maestro, ['--device', device, 'test', '--format', 'junit', '--output', path.join(output, 'report.xml'),
      '-e', `PORTRAIT_ORIENTATION=${orientations.portrait}`, '-e', `LANDSCAPE_ORIENTATION=${orientations.landscape}`,
      '--test-output-dir', output, '--debug-output', output, path.resolve('.maestro-household/members.yaml')],
    { stdio: ['ignore', log, log], timeout: 600_000, env: process.env })
    result.exitCode = run.status; result.driverCleanup = run.driverCleanup
    result.screenshots = inspectScreenshotOrientations(output, {
      'member-colour-portrait.png': 'portrait', 'member-colour-landscape.png': 'landscape',
      'member-colour-after-restart.png': 'portrait', 'member-colour-on-board.png': 'portrait', 'member-removed-after-restart.png': 'portrait',
    }, { includeStartup: false })
    if (run.error || run.status !== 0) throw new Error(`Native household flow failed (${run.error?.code ?? run.status}).`)
    if (!result.screenshots.passed) throw new Error('Member verification lacks required orientation/restart captures.')
    result.passed = true
  } catch (error) { result.error = error.message }
  finally {
    fs.closeSync(log)
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log(fs.readFileSync(path.join(output, 'maestro.log'), 'utf8'))
  }
  return result
}
module.exports = { householdFixture, runHouseholdSmoke }
