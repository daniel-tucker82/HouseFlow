const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process')
const { authFixture } = require('./native-auth-smoke.cjs')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')
const { runIOSUI } = require('../../.github/scripts/ios-device-process.cjs')

// This explicit fixture is in a private local schema, never the ordinary
// household used by the member journey. Changing it requires evidence review.
const expected = Object.freeze({ nonce: 'eaea552c-0ea6-4787-ab87-623483c49a7f',
  householdId: '345f6c31-4be1-41bb-b417-f270298c2c8c', keptHouseholdId: '5c658b4f-279a-4386-a612-31edff33d61d',
  accountId: 'user_3LakZJC9vvMEiR5zjQg3f3wn73V', schema: 'native_household_delete_eaea552c0ea64787ab87623483c49a7f' })

async function verifyHouseholdDeletionBackend(env = process.env, fetcher = fetch) {
  const fixture = authFixture(env)
  if (env.CYNTCH_NATIVE_HOUSEHOLD_DELETE_CHECK !== 'true' || env.CYNTCH_NATIVE_HOUSEHOLD_CHECK !== 'true' ||
    fixture?.email !== 'cyntch-native-20261103+clerk_test@example.com') throw new Error('Select the isolated household deletion fixture explicitly.')
  const response = await fetcher(new URL('/__cyntch-native-household-deletion-fixture', fixture.origin), {
    headers: { 'X-Cyntch-Verification': expected.nonce }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error('The backend has not enabled the private household deletion fixture.')
  const result = await response.json()
  if (Object.entries(expected).some(([name, value]) => result[name] !== value) || result.householdPresent !== true ||
    result.keptHouseholdPresent !== true || result.requestCount !== 0 || result.originalHouseholdProtected !== true ||
    result.privateSchema !== true || result.providerMutationsEnabled !== false || result.accountDeletionEnabled !== false) {
    throw new Error('Household deletion fixture isolation or untouched-state evidence did not match.')
  }
  return result
}

function runHouseholdDeletionSmoke({ maestro, device, output, orientations }) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !['linux', 'darwin'].includes(process.platform)) throw new Error('Use an owned Actions device.')
  fs.mkdirSync(output, { recursive: true })
  const result = { source: process.env.CYNTCH_ANDROID_APP_SHA || process.env.CYNTCH_IOS_APP_SHA || process.env.GITHUB_SHA,
    verificationSource: process.env.GITHUB_SHA, scope: 'One private-schema household deletion, saved receipt/restart, retained account and second household.', passed: false }
  const log = fs.openSync(path.join(output, 'maestro.log'), 'w')
  try {
    const check = spawnSync(process.execPath, [__filename, '--preflight'], { encoding: 'utf8', timeout: 12000, env: process.env })
    if (check.error || check.status !== 0) throw new Error('Private household deletion preflight failed; no native submission was started.')
    result.fixture = JSON.parse(check.stdout)
    const execute = process.platform === 'darwin' ? runIOSUI : spawnSync
    // Never retry this journey or the destructive submission.
    const run = execute(maestro, ['--device', device, 'test', '--format', 'junit', '--output', path.join(output, 'report.xml'),
      '-e', `PORTRAIT_ORIENTATION=${orientations.portrait}`, '--test-output-dir', output, '--debug-output', output,
      path.resolve('.maestro-household/delete-isolated.yaml')], { stdio: ['ignore', log, log], timeout: 480000, env: process.env })
    result.exitCode = run.status; result.driverCleanup = run.driverCleanup
    result.screenshots = inspectScreenshotOrientations(output, {
      'household-delete-ready.png': 'portrait', 'household-delete-receipt.png': 'portrait',
      'household-delete-kept-after-restart.png': 'portrait', 'household-delete-receipt-after-restart.png': 'portrait',
    }, { includeStartup: false })
    if (run.error || run.status !== 0 || !result.screenshots.passed) throw new Error('Private household deletion journey did not pass. Inspect its evidence before any further action.')
    result.passed = true
  } catch (error) { result.error = error.message }
  finally { fs.closeSync(log); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(fs.readFileSync(path.join(output, 'maestro.log'), 'utf8')) }
  return result
}
if (require.main === module) {
  if (process.argv[2] !== '--preflight') throw new Error('Only explicit preflight is supported.')
  verifyHouseholdDeletionBackend().then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
module.exports = { expected, verifyHouseholdDeletionBackend, runHouseholdDeletionSmoke }
