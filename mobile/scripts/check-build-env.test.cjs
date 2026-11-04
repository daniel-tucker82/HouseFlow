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
function check(overrides = {}, content) {
  const directory = mkdtempSync(join(tmpdir(), 'cyntch-build-env-'))
  try {
    const env = { ...process.env, EAS_BUILD_PROFILE: 'preview', EAS_BUILD_PLATFORM: 'android',
      EXPO_PUBLIC_API_URL: 'https://api.example.invalid', EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_fixture',
      GOOGLE_SERVICES_JSON: '', ...overrides }
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
    assert.equal(check({ EAS_BUILD_PROFILE: profile }, client).status, 0)
    assert.equal(check({ EAS_BUILD_PROFILE: profile, EAS_BUILD_PLATFORM: 'ios' }).status, 0)
  }
  assert.equal(check({ EAS_BUILD_PROFILE: 'development' }).status, 0)
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
test('dynamic config preserves existing native settings and only adds the supplied file path', () => {
  const configure = require('../app.config.js')
  const config = { ...require('../app.json').expo, extra: { eas: { projectId: 'preserved-fixture' } } }
  const previous = process.env.GOOGLE_SERVICES_JSON
  try {
    delete process.env.GOOGLE_SERVICES_JSON
    assert.deepEqual(configure({ config }), config)
    process.env.GOOGLE_SERVICES_JSON = '/builder/client-config.json'
    assert.deepEqual(configure({ config }), { ...config, android: { ...config.android,
      googleServicesFile: '/builder/client-config.json' } })
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_SERVICES_JSON
    else process.env.GOOGLE_SERVICES_JSON = previous
  }
})
