// Opt-in verification against an isolated household and Clerk development test
// identity. This never uses a password, provider secret or production account.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')

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

function runAuthenticatedSmoke({ maestro, device, output, orientations, fixture }) {
  fs.mkdirSync(output, { recursive: true })
  const result = { source: process.env.GITHUB_SHA, origin: fixture.origin,
    scope: 'Native email-code sign-in, household/task loading, rotation and session persistence after restart.', passed: false }
  const log = fs.openSync(path.join(output, 'maestro.log'), 'w')
  try {
    const run = spawnSync(maestro, ['--device', device, 'test', '--format', 'junit', '--output', path.join(output, 'report.xml'),
      '-e', `TEST_EMAIL=${fixture.email}`, '-e', `PORTRAIT_ORIENTATION=${orientations.portrait}`,
      '-e', `LANDSCAPE_ORIENTATION=${orientations.landscape}`, '--test-output-dir', output, '--debug-output', output,
      path.resolve('.maestro-auth/household.yaml')], { stdio: ['ignore', log, log], timeout: 300_000, env: process.env })
    result.exitCode = run.status
    result.orientationEvidence = inspectScreenshotOrientations(output, {
      'authenticated-board-portrait.png': 'portrait', 'authenticated-board-landscape.png': 'landscape',
      'authenticated-board-after-restart.png': 'portrait',
    }, { includeStartup: false })
    if (run.error || run.status !== 0) throw new Error(`Authenticated native flow failed (${run.error?.code ?? run.status}).`)
    if (!result.orientationEvidence.passed) throw new Error('Authenticated screenshots do not prove rotation and restart.')
    result.passed = true
  } catch (error) { result.error = error.message }
  finally {
    fs.closeSync(log)
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log(fs.readFileSync(path.join(output, 'maestro.log'), 'utf8'))
  }
  return result
}

if (require.main === module) console.log(authFixture() ? 'Isolated authenticated fixture configured.' : 'Signed-out verification only.')
module.exports = { authFixture, runAuthenticatedSmoke }
