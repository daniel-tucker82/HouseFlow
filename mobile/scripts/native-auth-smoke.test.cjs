const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
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
