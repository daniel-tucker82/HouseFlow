/* global __dirname */
const { Buffer } = require('node:buffer')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const client = {
  project_info: { project_number: '123456789', project_id: 'fixture-project' },
  client: [{
    client_info: { mobilesdk_app_id: '1:123456789:android:fixture', android_client_info: { package_name: 'com.cyntch.app' } },
    api_key: [{ current_key: 'public-fixture-key' }],
  }],
}
const liveOrigin = 'https://www.cyntch.com'
const liveEnv = {
  EXPO_PUBLIC_API_URL: liveOrigin,
  EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_' + Buffer.from('clerk.cyntch.com$').toString('base64'),
  EXPO_PUBLIC_PRIVACY_POLICY_URL: liveOrigin + '/legal/privacy', EXPO_PUBLIC_TERMS_URL: liveOrigin + '/legal/terms',
}
function check(overrides = {}, content) {
  const directory = mkdtempSync(join(tmpdir(), 'cyntch-build-env-'))
  try {
    const env = { ...process.env, EAS_BUILD_PROFILE: 'preview', EAS_BUILD_PLATFORM: 'android',
      EXPO_PUBLIC_API_URL: 'https://api.example.invalid', EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_fixture',
      EXPO_PUBLIC_PRIVACY_POLICY_URL: 'https://fixture.example/privacy', EXPO_PUBLIC_TERMS_URL: 'https://fixture.example/terms',
      GOOGLE_SERVICES_JSON: '', ...(overrides.EAS_BUILD_PROFILE === 'production' ? liveEnv : {}), ...overrides }
    if (content !== undefined) {
      env.GOOGLE_SERVICES_JSON = join(directory, 'google-services.json')
      writeFileSync(env.GOOGLE_SERVICES_JSON, typeof content === 'string' ? content : JSON.stringify(content))
    }
    const result = spawnSync(process.execPath, [join(__dirname, 'check-build-env.cjs')], { env, encoding: 'utf8' })
    assert.ifError(result.error)
    return { status: result.status, output: result.stdout + result.stderr }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
test('Android distributed builds require client config; iOS and development compilation do not', () => {
  for (const profile of ['preview', 'production']) {
    assert.notEqual(check({ EAS_BUILD_PROFILE: profile }).status, 0)
    const projectClient = profile === 'production'
      ? { ...client, project_info: { ...client.project_info, project_id: 'cyntch-2358a' } } : client
    assert.equal(check({ EAS_BUILD_PROFILE: profile }, projectClient).status, 0)
    assert.equal(check({ EAS_BUILD_PROFILE: profile, EAS_BUILD_PLATFORM: 'ios' }).status, 0)
  }
  assert.equal(check({ EAS_BUILD_PROFILE: 'development' }).status, 0)
})
test('a store build refuses valid but unrelated HTTPS, sign-in, policy and push destinations', () => {
  const store = { EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'ios' }
  for (const invalid of [
    { EXPO_PUBLIC_API_URL: 'https://preview.example.invalid' },
    { EXPO_PUBLIC_API_URL: liveOrigin + '/fixture' },
    { EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_' + Buffer.from('clerk.example.invalid$').toString('base64') },
    { EXPO_PUBLIC_PRIVACY_POLICY_URL: liveOrigin + '/legal/terms' },
    { EXPO_PUBLIC_TERMS_URL: 'https://example.invalid/legal/terms' },
  ]) {
    assert.notEqual(check({ ...store, ...invalid }).status, 0, Object.keys(invalid)[0])
  }
  assert.notEqual(check({ EAS_BUILD_PROFILE: 'production' }, client).status, 0, 'another Firebase project')
})
test('wrong app, wrong sender, ambiguous clients, malformed and unreadable files are rejected', () => {
  const wrongApp = structuredClone(client)
  wrongApp.client[0].client_info.android_client_info.package_name = 'another.app'
  const wrongSender = structuredClone(client)
  wrongSender.project_info.project_number = '987654321'
  const duplicates = structuredClone(client)
  duplicates.client.push(duplicates.client[0])
  for (const content of [wrongApp, wrongSender, duplicates, '{broken', null, { client: {} }]) {
    assert.notEqual(check({}, content).status, 0)
  }
  assert.notEqual(check({ GOOGLE_SERVICES_JSON: join(tmpdir(), 'cyntch-nonexistent-firebase-file.json') }).status, 0)
})
test('service-account credentials are rejected without disclosing their contents', () => {
  const result = check({}, { ...client, type: 'service_account', private_key: 'PRIVATE_FIXTURE_DO_NOT_LOG' })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /never a service-account private key/)
  assert.doesNotMatch(result.output, /PRIVATE_FIXTURE_DO_NOT_LOG/)
})
test('development config preserves native settings and only adds the supplied file path', () => {
  const configure = require('../app.config.js')
  const config = { ...require('../app.json').expo, extra: { eas: { projectId: 'preserved-fixture' } } }
  const previous = process.env.GOOGLE_SERVICES_JSON
  const previousProfile = process.env.EAS_BUILD_PROFILE
  try {
    process.env.EAS_BUILD_PROFILE = 'development'
    delete process.env.GOOGLE_SERVICES_JSON
    assert.deepEqual(configure({ config }), config)
    process.env.GOOGLE_SERVICES_JSON = '/builder/client-config.json'
    assert.deepEqual(configure({ config }), { ...config, android: { ...config.android,
      googleServicesFile: '/builder/client-config.json' } })
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_SERVICES_JSON
    else process.env.GOOGLE_SERVICES_JSON = previous
    if (previousProfile === undefined) delete process.env.EAS_BUILD_PROFILE
    else process.env.EAS_BUILD_PROFILE = previousProfile
  }
})
test('production requires both policy links; other builds may omit links but cannot supply unsafe URLs', () => {
  for (const name of ['EXPO_PUBLIC_PRIVACY_POLICY_URL', 'EXPO_PUBLIC_TERMS_URL']) {
    assert.notEqual(check({ EAS_BUILD_PROFILE: 'production', EAS_BUILD_PLATFORM: 'ios', [name]: '' }).status, 0)
    assert.equal(check({ EAS_BUILD_PROFILE: 'development', EAS_BUILD_PLATFORM: 'ios', [name]: '' }).status, 0)
    for (const value of ['http://fixture.example/privacy', 'javascript:alert(1)', 'https://user:PRIVATE_FIXTURE_DO_NOT_LOG@fixture.example/privacy', 'https://fixture.example/privacy?token=PRIVATE_FIXTURE_DO_NOT_LOG', 'https://fixture.example/privacy#section', 'not a URL']) {
      const result = check({ EAS_BUILD_PLATFORM: 'ios', [name]: value })
      assert.notEqual(result.status, 0)
      assert.doesNotMatch(result.output, /PRIVATE_FIXTURE_DO_NOT_LOG/)
    }
  }
})
test('runtime and build checks share URL normalization without network access or account data', () => {
  const { publicPolicyUrl } = require('../src/services/public-policy-url')
  assert.equal(publicPolicyUrl('  https://fixture.example/privacy  '), 'https://fixture.example/privacy')
  for (const value of [undefined, '', '   ', '/privacy', 'cyntch://privacy', 'https://user@fixture.example', 'https://fixture.example?account=1']) assert.equal(publicPolicyUrl(value), null)
})
