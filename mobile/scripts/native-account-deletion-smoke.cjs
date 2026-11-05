const fs = require('node:fs')
const path = require('node:path')
const { authFixture } = require('./native-auth-smoke.cjs')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')
const { runIOSUI } = require('../../.github/scripts/ios-device-process.cjs')

function deletionFixture(env = process.env) {
  const fixture = authFixture(env)
  if (env.CYNTCH_IOS_REPLAY_SCOPE !== 'account-deletion' || !fixture ||
    !/^cyntch-native-delete-[a-f0-9]{32}\+clerk_test@example\.com$/.test(fixture.email)) {
    throw new Error('Deletion verification requires its separately marked disposable development identity and explicit replay scope.')
  }
  return fixture
}

function runAccountDeletionSmoke({ maestro, device, output, orientations }) {
  deletionFixture()
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'darwin') throw new Error('Run the isolated deletion check on its owned iOS Actions simulator.')
  fs.mkdirSync(output, { recursive: true })
  const result = { source: process.env.CYNTCH_IOS_APP_SHA, verificationSource: process.env.GITHUB_SHA,
    scope: 'Disposable development account only: explicit review, cancellation, submission, receipt/restart and native cleanup. No store purchase or biometric-enrollment coverage.', passed: false }
  const log = fs.openSync(path.join(output, 'maestro.log'), 'w')
  try {
    // Never retry a destructive journey. A failed run keeps its logs, screenshots
    // and saved recovery information for inspection before any follow-up.
    const run = runIOSUI(maestro, ['--device', device, 'test', '--format', 'junit', '--output', path.join(output, 'report.xml'),
      '-e', `PORTRAIT_ORIENTATION=${orientations.portrait}`, '-e', `LANDSCAPE_ORIENTATION=${orientations.landscape}`,
      '--test-output-dir', output, '--debug-output', output, path.resolve('.maestro-account-deletion/delete.yaml')],
    { stdio: ['ignore', log, log], timeout: 600_000, env: process.env })
    result.exitCode = run.status
    result.driverCleanup = run.driverCleanup
    result.screenshots = inspectScreenshotOrientations(output, {
      'deletion-review-portrait.png': 'portrait', 'deletion-review-landscape.png': 'landscape',
      'deletion-cancelled-confirmation.png': 'portrait', 'deletion-accepted.png': 'portrait',
      'deletion-receipt-after-restart.png': 'portrait', 'deletion-completed.png': 'portrait',
      'deletion-cleanup-after-restart.png': 'portrait', 'deletion-signed-out-after-restart.png': 'portrait',
    }, { includeStartup: false })
    if (run.error || run.status !== 0) throw new Error(`Account deletion native flow failed (${run.error?.code ?? run.status}).`)
    if (!result.screenshots.passed) throw new Error('Deletion verification lacks required review/restart/cleanup captures.')
    result.passed = true
  } catch (error) { result.error = error.message }
  finally {
    fs.closeSync(log)
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log(fs.readFileSync(path.join(output, 'maestro.log'), 'utf8'))
  }
  return result
}
module.exports = { deletionFixture, runAccountDeletionSmoke }
