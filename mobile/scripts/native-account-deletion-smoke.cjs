const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
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

async function verifyAccountDeletionBackend(env = process.env, fetcher = fetch, now = Date.now()) {
  const fixture = deletionFixture(env)
  const compactNonce = fixture.email.slice('cyntch-native-delete-'.length).split('+')[0]
  const nonce = compactNonce.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
  const response = await fetcher(new URL('/__cyntch-native-account-deletion-fixture', fixture.origin), {
    headers: { 'X-Cyntch-Verification': nonce }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error('The backend has not attested a fresh disposable account deletion fixture.')
  const result = await response.json()
  const checkedAt = Date.parse(result.checkedAt)
  const workerUntil = Date.parse(result.workerUntil)
  if (result.nonce !== nonce || result.email !== fixture.email || result.schema !== 'native_delete_' + compactNonce ||
    !/^user_[A-Za-z0-9]+$/.test(result.accountId ?? '') || !/^[a-f0-9-]{36}$/.test(result.householdId ?? '') ||
    !/^local_member_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.childProfileId ?? '') ||
    result.privateSchema !== true || result.providerMarkerVerified !== true || result.providerSelfDeletionDisabled !== true ||
    result.householdPresent !== true || result.childProfilePresent !== true || result.requestCount !== 0 ||
    result.originalHouseholdProtected !== true || result.providerInventoryReady !== true || result.workerRunning !== true ||
    !Number.isFinite(checkedAt) || checkedAt > now + 5000 || now - checkedAt > 30000 ||
    !Number.isFinite(workerUntil) || workerUntil - now < 15 * 60 * 1000) {
    throw new Error('Disposable account isolation, provider readiness or unused-state evidence did not match.')
  }
  return result
}

function runAccountDeletionSmoke({ maestro, device, output, orientations }) {
  deletionFixture()
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'darwin') throw new Error('Run the isolated deletion check on its owned iOS Actions simulator.')
  fs.mkdirSync(output, { recursive: true })
  const result = { source: process.env.CYNTCH_IOS_APP_SHA, verificationSource: process.env.GITHUB_SHA,
    scope: 'Disposable development account only: explicit review, cancellation, submission, receipt/restart and native cleanup. No store purchase or biometric-enrollment coverage.', passed: false }
  const log = fs.openSync(path.join(output, 'maestro.log'), 'w')
  try {
    const check = spawnSync(process.execPath, [__filename, '--preflight'], { encoding: 'utf8', timeout: 12000, env: process.env })
    if (check.error || check.status !== 0) throw new Error('Account deletion preflight failed; no native submission was started.')
    result.fixture = JSON.parse(check.stdout)
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
      'deletion-submit-ready.png': 'portrait',
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
if (require.main === module) {
  if (process.argv[2] !== '--preflight') throw new Error('Only explicit preflight is supported.')
  verifyAccountDeletionBackend().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
module.exports = { deletionFixture, verifyAccountDeletionBackend, runAccountDeletionSmoke }
