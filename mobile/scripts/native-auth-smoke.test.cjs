const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { canRetryIOSBootstrap } = require('../../.github/scripts/ios-device-process.cjs')
const { authFixture, exactTextPattern } = require('./native-auth-smoke.cjs')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')

const configured = {
  EXPO_PUBLIC_API_URL: 'https://isolated-test.ngrok-free.app',
  CYNTCH_NATIVE_TEST_EMAIL: 'cyntch-native-test+clerk_test@example.com',
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_ZW1lcmdpbmctdG9hZC05OC5jbGVyay5hY2NvdW50cy5kZXYk',
}

test('the submitted identifier check requires the exact fixture including literal plus and dots', () => {
  const email = configured.CYNTCH_NATIVE_TEST_EMAIL
  const pattern = new RegExp(exactTextPattern(email))
  assert.equal(pattern.test(email), true)
  for (const other of [email.replace('+', ''), email.replace('+', 't'), email.replace('.', 'x'), 'x' + email, email + 'x']) {
    assert.equal(pattern.test(other), false)
  }
})
test('ordinary CI stays signed out and explicit configuration selects only the test fixture', () => {
  assert.equal(authFixture({}), null)
  assert.equal(authFixture({EXPO_PUBLIC_API_URL:'https://cyntch-simulator.invalid'}), null)
  assert.deepEqual(authFixture(configured), {email:configured.CYNTCH_NATIVE_TEST_EMAIL,origin:configured.EXPO_PUBLIC_API_URL})
})
test('partial, production, credential-bearing and non-test configurations fail before native execution', () => {
  for (const overrides of [
    { CYNTCH_NATIVE_TEST_EMAIL: '' }, { EXPO_PUBLIC_API_URL: '' },
    { CYNTCH_NATIVE_TEST_EMAIL: 'person@example.com' }, { EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_example' },
    ...['https://www.cyntch.com','http://isolated-test.ngrok-free.app','https://isolated-test.ngrok-free.app.evil.example',
      'https://user:password@isolated-test.ngrok-free.app','https://isolated-test.ngrok-free.app/path',
      'https://isolated-test.ngrok-free.app?key=value','https://isolated-test.ngrok-free.app#fragment',
      'https://isolated-test.ngrok-free.app:9000'].map(EXPO_PUBLIC_API_URL => ({EXPO_PUBLIC_API_URL})),
  ]) assert.throws(() => authFixture({...configured,...overrides}))
})
test('authentication evidence requires its named captures without weakening startup evidence', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-screenshot-scope-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(folder).startsWith('cyntch-screenshot-scope-'))
    fs.rmSync(folder, {recursive:true,force:true})
  })
  // Metadata-only fixture; does not establish actual rendering or device behavior.
  const bytes = Buffer.alloc(45)
  Buffer.from('89504e470d0a1a0a','hex').copy(bytes)
  bytes.writeUInt32BE(13,8); bytes.write('IHDR',12); bytes.writeUInt32BE(600,16); bytes.writeUInt32BE(1000,20); bytes.write('IEND',37)
  fs.writeFileSync(path.join(folder,'authenticated.png'),bytes)
  const expected = {'authenticated.png':'portrait'}
  assert.equal(inspectScreenshotOrientations(folder,expected,{includeStartup:false}).passed,true)
  assert.equal(inspectScreenshotOrientations(folder,expected).passed,false)
  assert.equal(inspectScreenshotOrientations(folder,{'absent.png':'portrait'},{includeStartup:false}).passed,false)
  assert.equal(inspectScreenshotOrientations(folder,{'authenticated.png':'landscape'},{includeStartup:false}).passed,false)
})

function runWithDriver(t, attempts, platform = 'darwin', options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-auth-bootstrap-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(folder).startsWith('cyntch-auth-bootstrap-'))
    fs.rmSync(folder, { recursive: true, force: true })
  })
  const calls = [], captures = []
  const execute = (_command, args, options) => {
    const spec = attempts[calls.length]
    assert.ok(spec, 'an unexpected extra attempt must fail')
    const output = args[args.indexOf('--test-output-dir') + 1]
    calls.push({ output, timeout: options.timeout, sessionJourney: args.includes('VERIFY_SESSION_JOURNEY=true') })
    assert.equal(args[args.indexOf('--debug-output') + 1], output)
    assert.equal(args[args.indexOf('--output') + 1], path.join(output, 'report.xml'))
    fs.writeSync(options.stdio[1], spec.log ?? '')
    if (spec.evidence) {
      const nested = path.join(output, 'nested-journey')
      fs.mkdirSync(nested)
      fs.writeFileSync(path.join(nested, spec.evidence), 'retained evidence')
    }
    return spec.result
  }
  const sandbox = { module: { exports: {} }, process: { platform, env: { CYNTCH_IOS_TEST_RUNTIME: '17.0' } },
    console: { log() {} }, require: name => {
      if (name === 'node:child_process') return { spawnSync: execute }
      if (name.endsWith('/ios-device-process.cjs')) return { runIOSUI: execute, canRetryIOSBootstrap }
      if (name === './device-screenshot-evidence.cjs') return { inspectScreenshotOrientations: (_folder, expected) => { captures.push(...Object.keys(expected)); return { passed: true } } }
      return require(name)
    } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'native-auth-smoke.cjs'), 'utf8'), sandbox)
  const result = sandbox.module.exports.runAuthenticatedSmoke({ maestro: 'maestro', device: 'owned-test-device', output: folder,
    orientations: { portrait: 'PORTRAIT', landscape: 'LANDSCAPE_LEFT' }, fixture: { email: configured.CYNTCH_NATIVE_TEST_EMAIL, origin: configured.EXPO_PUBLIC_API_URL }, ...options })
  return { folder, result, calls, captures }
}

test('focused journeys require real sign-in evidence without claiming repeated session or rotation checks', t => {
  const ok = [{ log: 'Flow: sign-in', result: { status: 0 } }]
  const full = runWithDriver(t, ok)
  const focused = runWithDriver(t, ok, 'darwin', { verifySessionJourney: false })
  assert.equal(full.calls[0].sessionJourney, true)
  assert.equal(focused.calls[0].sessionJourney, false)
  assert.equal(full.result.verifiesSessionJourney, true)
  assert.equal(focused.result.verifiesSessionJourney, false)
  assert.equal(full.captures.length, 7)
  assert.deepEqual(focused.captures, ['native-sign-in-identifier.png', 'native-sign-in-challenge.png', 'native-sign-in-methods.png', 'authenticated-board-portrait.png'])
})

const bootstrapLog = 'IOSDriverTimeoutException: iOS driver not ready in time'
const cleanedFailure = { status: 1, driverCleanup: { signalled: true } }

test('an unstarted authenticated iOS driver gets one cleaned retry with separate retained logs', t => {
  const { folder, result, calls } = runWithDriver(t, [
    { log: bootstrapLog, result: cleanedFailure }, { log: 'Flow: real sign-in journey', result: { status: 0 } },
  ])
  assert.equal(result.passed, true)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.timeout === 720_000), 'existing deadline is unchanged')
  assert.equal(calls[1].output, path.join(folder, 'bootstrap-retry'))
  assert.equal(fs.readFileSync(path.join(folder, 'maestro.log'), 'utf8'), bootstrapLog)
  assert.equal(result.attempts[0].retryBootstrap, true)
  assert.equal(result.attempts[1].retryBootstrap, false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'result.json'), 'utf8')).passed, true)
})

test('authentication commands, screenshots, reports, TLS failures and incomplete cleanup cannot trigger retries', t => {
  for (const spec of [
    ...['commands.json', 'report.xml', 'native-sign-in-identifier.png'].map(evidence => ({ evidence, log: bootstrapLog, result: cleanedFailure })),
    { log: bootstrapLog + '\nFlow: Native sign-in', result: cleanedFailure },
    { log: 'A TLS error caused the secure connection to fail.', result: cleanedFailure },
    { log: bootstrapLog, result: { status: 1 } },
    { log: bootstrapLog, result: { status: 1, driverCleanup: { error: 'EPERM' } } },
    { log: bootstrapLog, result: { ...cleanedFailure, error: { code: 'ETIMEDOUT' } } },
  ]) {
    const { result, calls } = runWithDriver(t, [spec])
    assert.equal(result.passed, false)
    assert.equal(calls.length, 1)
    assert.equal(result.attempts[0].retryBootstrap, false)
  }
})

test('repeated bootstrap failures stop at two attempts and Android never uses the iOS retry', t => {
  const spec = { log: bootstrapLog, result: cleanedFailure }
  const ios = runWithDriver(t, [spec, spec])
  assert.equal(ios.result.passed, false)
  assert.equal(ios.calls.length, 2)
  const android = runWithDriver(t, [spec], 'linux')
  assert.equal(android.result.passed, false)
  assert.equal(android.calls.length, 1)
  assert.equal(android.calls[0].timeout, 300_000)
})
