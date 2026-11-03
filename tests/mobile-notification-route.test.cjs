/* eslint-disable @typescript-eslint/no-require-imports -- Authenticated worker route without external push or database access. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { transformSync } = require('esbuild')
function load(relative, mocks) {
  const filename = path.resolve(__dirname, '..', relative), loaded = new Module(filename, module)
  loaded.require = id => mocks[id] ?? require(id)
  loaded._compile(transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code, filename)
  return loaded.exports
}
test('the native worker requires its cron secret, reports failures without detail and is inert while disabled', async () => {
  const oldSecret = process.env.CRON_SECRET, oldEnabled = process.env.NATIVE_PUSH_ENABLED
  let calls = 0, fail = false
  const route = load('app/api/internal/notifications/route.ts', { '@/lib/run-native-notifications': { async runNativeNotifications() {
    calls++
    if (fail) throw new Error('TOKEN must not be returned')
    return { enabled: true, sendAttempts: 3 }
  } } })
  const request = authorization => new Request('http://localhost/api/internal/notifications', { headers: authorization ? { authorization } : {} })
  try {
    delete process.env.CRON_SECRET
    assert.equal((await route.GET(request())).status, 503)
    process.env.CRON_SECRET = 'test-secret'
    assert.equal((await route.GET(request())).status, 401)
    assert.equal((await route.GET(request('Bearer incorrect-secret'))).status, 401)
    assert.equal(calls, 0)
    const accepted = await route.GET(request('Bearer test-secret'))
    assert.equal(accepted.status, 200)
    assert.equal(accepted.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await accepted.json(), { ok: true, enabled: true, sendAttempts: 3 })
    fail = true
    const failed = await route.GET(request('Bearer test-secret'))
    assert.equal(failed.status, 503)
    assert.ok(!(await failed.text()).includes('TOKEN'))
    delete process.env.NATIVE_PUSH_ENABLED
    const disabled = load('lib/run-native-notifications.ts', {
      '@/lib/db': { db: new Proxy({}, { get() { throw new Error('Database must not be used') } }) },
      '@/lib/expo-push-provider': { createExpoPushProvider() { throw new Error('Provider must not be used') } },
      '@/lib/native-notification-worker': { processNativeNotifications() { throw new Error('Worker must not be called') } },
    })
    assert.deepEqual(await disabled.runNativeNotifications(), { enabled: false, expanded: 0, queued: 0, sendAttempts: 0, receipts: 0 })
  } finally {
    if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret
    if (oldEnabled === undefined) delete process.env.NATIVE_PUSH_ENABLED; else process.env.NATIVE_PUSH_ENABLED = oldEnabled
  }
})
