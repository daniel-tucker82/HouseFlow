/* eslint-disable @typescript-eslint/no-require-imports -- Real SQLite, controlled OS events and navigation boundaries. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { randomUUID, createHash } = require('node:crypto')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const root = path.resolve(__dirname, '..')
function load(files, mocks = {}) {
  const loaded = new Module(__filename, module); loaded.require = id => mocks[id] ?? require(id)
  loaded._compile(buildSync({ stdin: { contents: files.map(file => `export * from ${JSON.stringify(path.join(root, file))};`).join('\n'), resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: Object.keys(mocks) }).outputFiles[0].text, __filename)
  return loaded.exports
}
const { LocalStore, NotificationController, NotificationNavigationController, notificationCatalog, defaultNotificationPreferences,
  parseNativeNotificationPayload } = load(['mobile/src/storage/local-store.ts', 'mobile/src/services/notification-controller.ts',
  'mobile/src/services/notification-navigation.ts', 'shared/mobile/notification-payload.ts', 'shared/mobile/notification-catalog.ts'])
const session = { accountId: 'parent', sessionId: 'sess_current' }
const hash = value => createHash('sha256').update(value).digest('hex')
const household = { id: randomUUID(), name: 'Family', role: 'manager', timezone: 'UTC' }, other = { ...household, id: randomUUID(), name: 'Other' }
const members = [{ id: 'parent', name: 'Parent' }, { id: 'daughter', name: 'Daughter' }]
function payload(kind = 'task_available', values = {}) {
  const member = notificationCatalog[kind].scope === 'member', run = member || kind.startsWith('routine_')
  return { version: 3, ...session, deliveryId: randomUUID(), eventId: randomUUID(), householdId: household.id, kind,
    hasDetails: false, expiresAt: Date.now() + 3600000, memberSelectionHash: member ? hash('["parent"]') : null,
    ...(run ? { occurrenceId: randomUUID() } : {}), ...(member ? { taskId: randomUUID() } : {}), ...values }
}
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-notification-taps-')), filename = path.join(dir, 'device.db')
  let db = new Database(filename), local = new LocalStore(db); await local.initialize(); await local.notificationSessions.activate(session)
  t.after(() => { db.db.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }) })
  return { get db() { return db }, get local() { return local }, reopen: async () => {
    await db.tail; db.db.close(); db = new Database(filename); local = new LocalStore(db); await local.initialize()
  } }
}
async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!await predicate()) { if (Date.now() > deadline) assert.fail('Timed out'); await new Promise(resolve => setImmediate(resolve)) }
}
function navigation(f, overrides = {}) {
  const navigated = [], opened = [], failures = []
  const state = { board: { household, members, tasks: [] }, households: [household, other], loading: false, online: false, error: null }
  const board = { getSnapshot: () => state, refresh: async () => {}, selectHousehold: async id => { state.board.household = state.households.find(item => item.id === id) } }
  const api = { ready: () => true, allowed: () => true, navigate: route => navigated.push(route), failed: (message, retry, dismiss) => failures.push({ message, retry, dismiss }), ...overrides }
  const taps = new NotificationNavigationController(f.local.notificationInbox, session, board, { openRun: async (...args) => opened.push(args), closeRun: () => {} }, api)
  return { taps, navigated, opened, failures, state, board, api }
}

test('notification payloads accept only known events/identifiers and never carry an arbitrary URL into navigation', () => {
  const original = payload(), parsed = parseNativeNotificationPayload({ ...original, url: 'https://attacker.test', title: 'Private name' })
  assert.deepEqual(parsed, original)
  for (const fields of [{ version: 2 }, { householdId: '../settings' }, { occurrenceId: null }, { taskId: 'file://x' },
    { sessionId: 'invalid' }, { kind: '__proto__' }, { memberSelectionHash: null }, { expiresAt: NaN }, { hasDetails: undefined }]) {
    assert.equal(parseNativeNotificationPayload({ ...original, ...fields }), null)
  }
  for (const kind of Object.keys(notificationCatalog)) assert.ok(parseNativeNotificationPayload(payload(kind)))
})

test('taps survive restart, duplicate delivery cannot supersede a later tap, and a failed write preserves the previous destination', async t => {
  const f = await fixture(t), first = payload(), second = payload('routine_completed')
  await f.local.notificationInbox.capture(first, session); await f.reopen()
  assert.deepEqual(await f.local.notificationInbox.pending(session), first)
  await f.db.execAsync("CREATE TRIGGER reject_tap BEFORE INSERT ON notification_taps BEGIN SELECT RAISE(ABORT,'disk full'); END")
  await assert.rejects(f.local.notificationInbox.capture(second, session), /disk full/)
  assert.deepEqual(await f.local.notificationInbox.pending(session), first)
  await f.db.execAsync('DROP TRIGGER reject_tap')
  await f.local.notificationInbox.capture(second, session)
  await f.local.notificationInbox.capture(first, session)
  assert.deepEqual(await f.local.notificationInbox.pending(session), second)
  assert.equal(await f.local.notificationInbox.capture({ ...first, sessionId: 'sess_old' }, session), false)
  await f.local.notificationSessions.close(session)
  assert.equal(await f.local.notificationInbox.pending(session), null)
  assert.equal(await f.local.notificationInbox.capture(first, session), false)
  assert.equal((await f.db.getFirstAsync('SELECT COUNT(*) AS n FROM notification_taps')).n, 0)
})

test('cold tap waits for navigation, switches households, opens the exact run/task and does not navigate again on redelivery', async t => {
  const f = await fixture(t), p = payload('task_completed', { householdId: other.id })
  let ready = false
  const n = navigation(f, { ready: () => ready }); t.after(() => n.taps.stop())
  await n.taps.capture(p); await new Promise(resolve => setImmediate(resolve)); assert.equal(n.navigated.length, 0)
  n.taps.stop(); await f.reopen()
  const resumed = navigation(f); t.after(() => resumed.taps.stop()); ready = true; resumed.taps.wake()
  await until(() => resumed.opened.length === 1)
  await until(async () => await f.local.notificationInbox.pending(session) === null)
  assert.deepEqual(resumed.navigated, ['/runs']); assert.deepEqual(resumed.opened[0], [p.occurrenceId, p.taskId])
  assert.equal(resumed.state.board.household.id, other.id)
  await resumed.taps.capture(p); await new Promise(resolve => setImmediate(resolve))
  assert.equal(resumed.opened.length, 1)
  await resumed.taps.capture(payload('member_added'))
  await until(() => resumed.navigated.at(-1) === '/household')
})

test('current access and application restrictions win over a notification, including changes while selecting its household', async t => {
  for (const scenario of ['removed', 'role', 'restricted', 'switch-role']) await t.test(scenario, async sub => {
    const f = await fixture(sub), n = navigation(f); sub.after(() => n.taps.stop())
    n.state.online = true
    if (scenario === 'removed') n.board.refresh = async () => { n.state.households = [] }
    if (scenario === 'role') n.state.households = [{ ...household, role: 'member' }]
    if (scenario === 'restricted') n.api.allowed = () => false
    if (scenario === 'switch-role') n.board.selectHousehold = async () => { n.state.board.household = { ...other, role: 'member' } }
    await n.taps.capture(payload('member_added', { householdId: scenario === 'switch-role' ? other.id : household.id }))
    if (scenario === 'restricted') await until(async () => await f.local.notificationInbox.pending(session) === null)
    else { await until(() => n.failures.length === 1); n.failures[0].dismiss(); await until(async () => await f.local.notificationInbox.pending(session) === null) }
    assert.equal(n.navigated.length, 0)
  })
})

test('a later tap supersedes an in-flight open, and sign-out during refresh cannot navigate', async t => {
  const f = await fixture(t), n = navigation(f); t.after(() => n.taps.stop()); n.state.online = true
  let release, calls = 0
  n.board.refresh = async () => { if (++calls === 1) await new Promise(resolve => { release = resolve }) }
  const first = payload(), second = payload('routine_completed')
  await n.taps.capture(first); await until(() => Boolean(release)); await n.taps.capture(second); release()
  await until(() => n.opened.length === 1)
  assert.equal(n.opened[0][0], second.occurrenceId)
  await until(async () => await f.local.notificationInbox.pending(session) === null)
  n.board.refresh = async () => new Promise(resolve => { release = resolve }); release = null
  await n.taps.capture(payload()); await until(() => Boolean(release))
  n.taps.stop(); await f.local.notificationSessions.close(session); release()
  await new Promise(resolve => setImmediate(resolve)); assert.equal(n.opened.length, 1)
})

test('foreground policy honors all event choices, member selection, privacy, quiet hours, roles and other households without doing I/O', async t => {
  const f = await fixture(t), preferences = defaultNotificationPreferences('parent', 'UTC')
  for (const [kind, selection] of Object.entries(preferences.categories)) { selection.enabled = true; selection.memberIds = notificationCatalog[kind].scope === 'member' ? ['daughter'] : [] }
  await f.local.notifications.save('parent', household.id, preferences)
  await f.local.notifications.save('parent', other.id, preferences)
  const native = { inspect: async () => ({ permission: 'granted', canAskAgain: true }), token: async () => 'ExpoPushToken[test]',
    details: () => ({ platform: 'android', deviceName: 'Phone', appVersion: '1' }), listenForTokenChange: () => () => {} }
  const c = new NotificationController(f.local.notifications, 'parent', {}, native, randomUUID, Date.now, async value => hash(value))
  t.after(() => c.stop())
  const state = { board: { household, members, tasks: [] }, households: [household, other], loading: false }
  c.observe(state); await c.start()
  const completed = payload('task_completed', { memberSelectionHash: hash('["daughter"]') })
  await until(() => c.canPresent(completed))
  for (const kind of Object.keys(notificationCatalog)) assert.equal(c.canPresent(payload(kind, { memberSelectionHash: notificationCatalog[kind].scope === 'member' ? hash('["daughter"]') : null })), true, kind)
  assert.equal(c.canPresent({ ...completed, householdId: other.id }), true)
  assert.equal(c.canPresent({ ...completed, householdId: randomUUID() }), false)
  assert.equal(c.canPresent({ ...completed, accountId: 'other' }), false)
  assert.equal(c.canPresent({ ...completed, hasDetails: true }), false)
  assert.equal(c.canPresent({ ...completed, expiresAt: Date.now() - 1 }), true, 'provider TTL controls expiry; a fast device clock must not silence valid alerts')
  const all = f.local.notifications.all; f.local.notifications.all = () => { throw new Error('presentation must not read disk') }
  assert.equal(c.canPresent(completed), true); f.local.notifications.all = all
  const save = f.local.notifications.save.bind(f.local.notifications); let release
  f.local.notifications.save = async (...args) => { await new Promise(resolve => { release = resolve }); return save(...args) }
  const changing = c.changePreferences(p => ({ ...p, categories: { ...p.categories, task_completed: { enabled: true, memberIds: ['parent'] } } }))
  assert.equal(c.canPresent(completed), false, 'unsaved member choices take effect immediately')
  release(); await changing; f.local.notifications.save = save
  await c.changePreferences(p => ({ ...p, quietHours: { start: '00:00', end: '00:00' } }))
  assert.equal(c.canPresent(payload('member_added')), false)
  c.observe({ ...state, households: [{ ...household, role: 'member' }] })
  assert.equal(c.canPresent(payload('member_added')), false)
  c.setActive(false); assert.equal(c.canPresent(completed), false)
})

test('native foreground handling fails closed, avoids duplicate banners and clears a tap only after capture without clearing a newer tap', async () => {
  let handler, responseListener, receivedListener, last, clears = 0, presentedAllowed = true
  const pending = [], refreshes = []
  const native = { DEFAULT_ACTION_IDENTIFIER: 'default', setNotificationHandler: value => { handler = value },
    addNotificationResponseReceivedListener: value => { responseListener = value; return { remove() {} } },
    addNotificationReceivedListener: value => { receivedListener = value; return { remove() {} } },
    getLastNotificationResponse: () => last, clearLastNotificationResponse: () => { clears++; last = null }, dismissNotificationAsync: async () => {},
  }
  const { bindNotificationEvents } = load(['mobile/src/services/notification-events.ts'], { 'expo-notifications': native })
  const notification = p => ({ request: { identifier: p.deliveryId, content: { data: p } } })
  const first = payload(), second = payload()
  assert.equal((await handler.handleNotification(notification(first))).shouldShowBanner, false, 'startup has no active session policy')
  last = { notification: notification(first), actionIdentifier: 'default' }
  const binding = bindNotificationEvents({ session, canPresent: () => presentedAllowed, canPlaySound: () => false,
    capture: () => new Promise(resolve => pending.push(resolve)), received: p => refreshes.push(p), failed: () => assert.fail('unexpected failure') })
  const result = await handler.handleNotification(notification(first))
  assert.equal(result.shouldShowBanner, true); assert.equal(result.shouldShowList, true); assert.equal(result.shouldPlaySound, false)
  assert.equal((await handler.handleNotification(notification(first))).shouldShowBanner, false)
  assert.equal(clears, 0)
  last = { notification: notification(second), actionIdentifier: 'default' }; responseListener(last)
  pending[0](true); await new Promise(resolve => setImmediate(resolve)); assert.equal(clears, 0)
  pending[1](true); await until(() => clears === 1)
  receivedListener(notification({ ...first, sessionId: 'sess_old' })); assert.equal(refreshes.length, 0)
  receivedListener(notification(first)); assert.equal(refreshes.length, 1)
  presentedAllowed = false; assert.equal((await handler.handleNotification(notification(second))).shouldShowBanner, false)
  binding.stop(); assert.equal((await handler.handleNotification(notification(payload()))).shouldShowBanner, false)
})
