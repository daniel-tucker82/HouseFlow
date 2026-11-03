/* eslint-disable @typescript-eslint/no-require-imports -- Durable SQLite and controlled native/provider boundaries. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
function load(files, mocks = {}) {
  const loaded = new Module(__filename, module)
  loaded.require = id => mocks[id] ?? require(id)
  loaded._compile(buildSync({ stdin: { contents: files.map(file => `export * from ${JSON.stringify(path.join(root, file))};`).join('\n'), resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: Object.keys(mocks) }).outputFiles[0].text, __filename)
  return loaded.exports
}
const { LocalStore, NotificationSessionController, notificationRevocationTransport, defaultNotificationPreferences } = load([
  'mobile/src/storage/local-store.ts', 'mobile/src/services/notification-session-controller.ts', 'shared/mobile/notification-catalog.ts',
])
const old = { accountId: 'parent', sessionId: 'sess_old' }, fresh = { accountId: 'parent', sessionId: 'sess_new' }
const registration = { platform: 'android', permission: 'granted', token: 'ExpoPushToken[test]', deviceName: 'Phone', appVersion: '1' }
class Database {
  constructor(filename) { this.db = new DatabaseSync(filename); this.tail = Promise.resolve() }
  async execAsync(sql) { this.db.exec(sql) }
  async runAsync(sql, ...values) { return this.db.prepare(sql).run(...values) }
  async getFirstAsync(sql, ...values) { return this.db.prepare(sql).get(...values) ?? null }
  async getAllAsync(sql, ...values) { return this.db.prepare(sql).all(...values) }
  async withExclusiveTransactionAsync(work) {
    const result = this.tail.then(async () => { this.db.exec('BEGIN IMMEDIATE'); try { await work(this); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error } })
    this.tail = result.catch(() => {}); return result
  }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-notification-session-')), filename = path.join(dir, 'device.db')
  let db = new Database(filename), local = new LocalStore(db); await local.initialize()
  t.after(() => { db.db.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }) })
  return { get db() { return db }, get local() { return local }, get sessions() { return local.notificationSessions }, reopen: async () => {
    await db.tail; db.db.close(); db = new Database(filename); local = new LocalStore(db); await local.initialize()
  } }
}
async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!await predicate()) { if (Date.now() > deadline) assert.fail('Timed out'); await new Promise(resolve => setImmediate(resolve)) }
}

test('offline sign-out survives restart without losing tasks or preferences; late old-session writes cannot replace a new registration', async t => {
  const f = await fixture(t)
  await f.sessions.activate(old)
  const oldSettings = f.local.notifications.forSession(old.accountId, old.sessionId)
  await oldSettings.save('parent', 'device', registration)
  const preferences = defaultNotificationPreferences('parent', 'UTC')
  preferences.categories.task_completed = { enabled: true, memberIds: ['daughter'] }
  await oldSettings.save('parent', 'household', preferences)
  const board = { household: { id: 'household', role: 'manager' }, tasks: [{ id: 'task', occurrence_id: 'run', status: 'unlocked', assignee_ids: ['daughter'] }] }
  await f.local.cacheBoard('parent', board)
  await f.local.enqueueCompletion({ id: 'edit', accountId: 'parent', householdId: 'household', deviceId: 'phone', taskId: 'task', occurrenceId: 'run', memberId: 'daughter', completed: true, deviceTimeMs: 1000 })
  await f.sessions.close(old)
  await f.reopen()
  assert.equal((await f.sessions.activate(old)).allowed, false)
  assert.equal((await f.sessions.pending())[0].sessionId, old.sessionId)
  assert.equal((await f.local.notifications.get('parent', 'device')).desired, null)
  assert.deepEqual((await f.local.notifications.get('parent', 'household')).desired, preferences)
  assert.equal((await f.db.getFirstAsync('SELECT COUNT(*) AS n FROM pending_completions')).n, 1)
  await f.sessions.activate(fresh)
  const freshSettings = f.local.notifications.forSession(fresh.accountId, fresh.sessionId)
  await freshSettings.save('parent', 'device', { ...registration, token: 'ExpoPushToken[new]' })
  await f.sessions.close(old)
  assert.equal((await f.local.notifications.get('parent', 'device')).desired.token, 'ExpoPushToken[new]')
  const stale = f.local.notifications.forSession(old.accountId, old.sessionId)
  await assert.rejects(stale.save('parent', 'device', registration), /ended/)
  await assert.rejects(stale.cache('parent', { accountId: 'parent', revision: '999', hasToken: true }), /ended/)
  assert.equal((await f.sessions.activate(old)).allowed, false)
  assert.ok(await f.db.getFirstAsync('SELECT 1 FROM notification_sessions WHERE session_id=? AND revoked=0', fresh.sessionId))
  await f.sessions.acknowledge(old)
  assert.equal((await f.sessions.pending()).length, 0)
  assert.equal((await f.sessions.activate(old)).allowed, false, 'acknowledgement retains the local tombstone')
})

test('session/cache/OS-cleanup changes are atomic and an old cleanup acknowledgement cannot erase newer work', async t => {
  const f = await fixture(t)
  await f.sessions.activate(old)
  const initial = await f.sessions.cleanupVersion(); await f.sessions.completeCleanup(initial)
  await f.local.notifications.save('parent', 'device', registration)
  await f.db.execAsync("CREATE TRIGGER reject_cleanup BEFORE UPDATE ON notification_native_cleanup BEGIN SELECT RAISE(ABORT,'disk failure'); END")
  await assert.rejects(f.sessions.close(old), /disk failure/)
  assert.equal((await f.sessions.activate(old)).allowed, true)
  assert.equal((await f.sessions.pending()).length, 0)
  assert.deepEqual((await f.local.notifications.get('parent', 'device')).desired, registration)
  await f.db.execAsync('DROP TRIGGER reject_cleanup')
  await f.sessions.close(old)
  const previous = await f.sessions.cleanupVersion()
  await f.sessions.activate(fresh)
  await f.sessions.completeCleanup(previous)
  assert.ok(await f.sessions.cleanupVersion() > previous)
  await f.reopen()
  assert.ok(await f.sessions.cleanupVersion() > previous, 'unfinished native cleanup survives a crash after sign-in')
  await f.sessions.completeCleanup(await f.sessions.cleanupVersion())
  assert.equal(await f.sessions.cleanupVersion(), null)
})

test('signed-out revocations retry lost replies after restart and respect connectivity, lifecycle and persisted backoff', async t => {
  const f = await fixture(t)
  await f.sessions.activate(old); await f.sessions.close(old)
  let now = 1000, calls = 0
  const first = new NotificationSessionController(f.sessions, async () => { calls++; throw new Error('Reply lost') }, () => now)
  first.wake(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 0)
  first.setConnectivity(true)
  await until(async () => (await f.sessions.pending())[0]?.attempts === 1)
  first.stop()
  const retryAt = (await f.sessions.pending())[0].nextAttemptMs
  await f.reopen()
  const next = new NotificationSessionController(f.sessions, async session => { assert.equal(session.sessionId, old.sessionId); calls++ }, () => now)
  t.after(() => next.stop())
  next.setActive(false); next.setConnectivity(true)
  now = retryAt
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1)
  next.setActive(true)
  await until(async () => (await f.sessions.pending()).length === 0)
  assert.equal(calls, 2)
  assert.equal((await f.sessions.activate(old)).allowed, false)
})

test('revocation transport works without a login token, requires HTTPS and acknowledges only an exact session identity', async () => {
  assert.throws(() => notificationRevocationTransport('http://example.test', 'phone', async () => 'secret'), /secure/)
  let result = { revoked: true, deviceId: 'phone', ...old }
  const transport = notificationRevocationTransport('https://example.test', 'phone', async () => 'installation-proof', async (url, options) => {
    assert.equal(url, 'https://example.test/api/mobile/notifications/revoke')
    assert.equal(options.headers.Authorization, undefined)
    assert.equal(options.headers['X-Cyntch-Installation'], 'installation-proof')
    assert.deepEqual(JSON.parse(options.body), old)
    return Response.json(result)
  })
  await transport(old)
  for (const wrong of [{ sessionId: 'sess_wrong' }, { accountId: 'other' }, { deviceId: 'other' }, { revoked: false }]) {
    result = { revoked: true, deviceId: 'phone', ...old, ...wrong }
    await assert.rejects(transport(old), /waiting to sync/)
  }
})

test('native token destruction is ordered between old and new token requests, and failures retain durable cleanup', async t => {
  const f = await fixture(t), events = []
  let fail = false
  const native = {
    getLastNotificationResponse: () => null, getPresentedNotificationsAsync: async () => [], getAllScheduledNotificationsAsync: async () => [],
    unregisterForNotificationsAsync: async () => { events.push('unregister'); if (fail) throw new Error('Unavailable') },
  }
  const { withNativeNotificationSession: serial, resetNativeNotificationSession: reset, waitForNativeNotification: bounded } = load(['mobile/src/services/notification-native-session.ts'], { 'expo-notifications': native })
  await f.sessions.activate(old)
  let release
  const running = serial(async () => { events.push('old-request'); await new Promise(resolve => { release = resolve }); events.push('old-return') })
  await until(() => Boolean(release))
  const cleanup = reset(f.sessions), newer = serial(async () => { events.push('new-request') })
  assert.equal(reset(f.sessions), cleanup, 'repeated connectivity events share one cleanup')
  await assert.rejects(bounded(cleanup, 5), /taking longer/)
  assert.deepEqual(events, ['old-request'])
  release(); await Promise.all([running, cleanup, newer])
  assert.ok(events.indexOf('old-return') < events.indexOf('unregister'))
  assert.ok(events.indexOf('unregister') < events.indexOf('new-request'))
  assert.equal(await f.sessions.cleanupVersion(), null)
  await f.sessions.close(old); fail = true
  await assert.rejects(reset(f.sessions), /waiting to finish/)
  assert.notEqual(await f.sessions.cleanupVersion(), null)
  fail = false; await reset(f.sessions)
  assert.equal(await f.sessions.cleanupVersion(), null)
})

test('retried cleanup preserves the current session cold-start tap and tray items, but clears them after sign-out', async t => {
  const f = await fixture(t)
  await f.sessions.activate(old); await f.sessions.close(old); await f.sessions.activate(fresh)
  await f.reopen()
  const request = (session, extra = {}) => ({ identifier: randomUUID(), content: { data: {
    version: 3, ...session, deliveryId: randomUUID(), eventId: randomUUID(), householdId: randomUUID(),
    kind: 'member_added', hasDetails: false, memberSelectionHash: null, expiresAt: Date.now() + 3600000, ...extra,
  } } })
  const current = request(fresh), previous = request(old), anotherAccount = request({ ...fresh, accountId: 'other' }), unknown = request(fresh, { version: 1 })
  let presented = [current, previous, anotherAccount, unknown].map(request => ({ request })), scheduled = [current, previous]
  let last = { notification: { request: current } }, fail = true, clears = 0
  const native = {
    getLastNotificationResponse: () => last, clearLastNotificationResponse: () => { clears++; last = null },
    getPresentedNotificationsAsync: async () => presented, getAllScheduledNotificationsAsync: async () => scheduled,
    dismissNotificationAsync: async id => { presented = presented.filter(item => item.request.identifier !== id) },
    cancelScheduledNotificationAsync: async id => { scheduled = scheduled.filter(item => item.identifier !== id) },
    unregisterForNotificationsAsync: async () => { if (fail) throw new Error('Provider unavailable') },
  }
  const { resetNativeNotificationSession: reset } = load(['mobile/src/services/notification-native-session.ts'], { 'expo-notifications': native })
  await assert.rejects(reset(f.sessions), /waiting to finish/)
  assert.deepEqual(presented, [{ request: current }]); assert.deepEqual(scheduled, [current])
  assert.equal(last.notification.request.identifier, current.identifier); assert.equal(clears, 0)
  assert.notEqual(await f.sessions.cleanupVersion(), null)
  fail = false; await reset(f.sessions)
  assert.equal(last.notification.request.identifier, current.identifier)
  assert.equal(await f.sessions.cleanupVersion(), null)
  await f.sessions.close(fresh); await reset(f.sessions)
  assert.equal(last, null); assert.equal(clears, 1)
  assert.deepEqual(presented, []); assert.deepEqual(scheduled, [])
})
