// Opt-in verification against an isolated household and Clerk development test
// identity. This never uses a password, provider secret or production account.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')
const { runIOSUI, canRetryIOSBootstrap } = require('../../.github/scripts/ios-device-process.cjs')

function hasFlowEvidence(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).some(entry => entry.isDirectory()
    ? hasFlowEvidence(path.join(folder, entry.name))
    : entry.name === 'commands.json' || entry.name === 'report.xml' || entry.name.endsWith('.png'))
}

function authFixture(env = process.env) {
  const email = env.CYNTCH_NATIVE_TEST_EMAIL ?? ''
  const address = env.EXPO_PUBLIC_API_URL ?? ''
  if (!email && (!address || address === 'https://cyntch-simulator.invalid')) return null
  if (!/^cyntch-native-[a-z0-9-]+\+clerk_test@example\.com$/.test(email)) throw new Error('Use the isolated Cyntch Clerk test identity.')
  const url = new URL(address)
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.ngrok-free\.app$/.test(url.hostname)
    || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use the temporary HTTPS tunnel to the isolated development backend.')
  }
  if (env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY !== 'pk_test_ZW1lcmdpbmctdG9hZC05OC5jbGVyay5hY2NvdW50cy5kZXYk') {
    throw new Error('Authenticated verification requires the Cyntch development Clerk instance.')
  }
  return { email, origin: url.origin }
}

function exactTextPattern(value) {
  return '^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'
}

function runAuthenticatedSmoke({ maestro, device, output, orientations, fixture, verifySessionJourney = true }) {
  fs.mkdirSync(output, { recursive: true })
  const result = { source: process.env.CYNTCH_IOS_APP_SHA || process.env.CYNTCH_ANDROID_APP_SHA || process.env.GITHUB_SHA, origin: fixture.origin,
    scope: verifySessionJourney ? 'Native email-code sign-in, household/task loading, rotation and session persistence after restart.'
      : 'Native email-code sign-in and household/task loading before a separate focused journey; no repeated chooser, rotation or session-persistence check.',
    verifiesSessionJourney: verifySessionJourney, passed: false }
  try {
    let run
    const ios = process.platform === 'darwin'
    result.attempts = []
    for (let attempt = 1; attempt <= (ios ? 2 : 1); attempt++) {
      const attemptFolder = attempt === 1 ? output : path.join(output, 'bootstrap-retry')
      fs.mkdirSync(attemptFolder, { recursive: true })
      const log = fs.openSync(path.join(attemptFolder, 'maestro.log'), 'w')
      try {
        run = (ios ? runIOSUI : spawnSync)(maestro, ['--device', device, 'test', '--format', 'junit', '--output', path.join(attemptFolder, 'report.xml'),
          '-e', `TEST_EMAIL=${fixture.email}`, '-e', `TEST_EMAIL_PATTERN=${exactTextPattern(fixture.email)}`,
          '-e', `PORTRAIT_ORIENTATION=${orientations.portrait}`,
          '-e', `LANDSCAPE_ORIENTATION=${orientations.landscape}`, '--test-output-dir', attemptFolder, '--debug-output', attemptFolder,
          '-e', `VERIFY_SESSION_JOURNEY=${verifySessionJourney ? 'true' : 'false'}`,
          path.resolve('.maestro-auth/household.yaml')], { stdio: ['ignore', log, log],
          timeout: !ios ? 300_000 : process.env.CYNTCH_IOS_TEST_RUNTIME === '17.0' ? 720_000 : 540_000, env: process.env })
      } finally { fs.closeSync(log) }
      const driverOutput = fs.readFileSync(path.join(attemptFolder, 'maestro.log'), 'utf8')
      console.log(driverOutput)
      // A retry can only bootstrap the driver: no authentication command,
      // screenshot or flow report may exist, and owned cleanup must finish.
      const retryBootstrap = ios && attempt === 1 && canRetryIOSBootstrap(run, driverOutput, hasFlowEvidence(attemptFolder))
      result.attempts.push({ attempt, exitCode: run.status, error: run.error?.code, driverCleanup: run.driverCleanup, retryBootstrap })
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
      if (!retryBootstrap) break
    }
    result.exitCode = run.status
    result.orientationEvidence = inspectScreenshotOrientations(output, {
      'native-sign-in-identifier.png': 'portrait',
      'native-sign-in-challenge.png': 'portrait',
      'native-sign-in-methods.png': 'portrait',
      'authenticated-board-portrait.png': 'portrait',
      ...(verifySessionJourney ? { 'authenticated-household-chooser.png': 'portrait',
        'authenticated-board-landscape.png': 'landscape', 'authenticated-board-after-restart.png': 'portrait' } : {}),
    }, { includeStartup: false })
    if (run.error || run.status !== 0) throw new Error(`Authenticated native flow failed (${run.error?.code ?? run.status}).`)
    if (!result.orientationEvidence.passed) throw new Error('Authenticated screenshots do not prove the selected sign-in scope.')
    result.passed = true
  } catch (error) { result.error = error.message }
  finally {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  }
  return result
}

if (require.main === module) console.log(authFixture() ? 'Isolated authenticated fixture configured.' : 'Signed-out verification only.')
module.exports = { authFixture, exactTextPattern, runAuthenticatedSmoke }
