/* eslint-disable @typescript-eslint/no-require-imports -- Real device SQLite and deterministic notification transport/native adapters. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const { randomUUID } = require('node:crypto')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const files = ['mobile/src/storage/local-store.ts', 'mobile/src/services/notification-controller.ts', 'mobile/src/storage/sync-engine.ts', 'shared/mobile/notification-catalog.ts']
const compiled = buildSync({ stdin: { contents: files.map(file => `export * from ${JSON.stringify(path.join(root, file))};`).join('\n'), resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = new Module(__filename, module); loaded._compile(compiled.outputFiles[0].text, __filename)
const { LocalStore, NotificationController, TransportError, defaultNotificationPreferences } = loaded.exports
const householdId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const household = { id: householdId, name: 'Family', timezone: 'Australia/Sydney', role: 'manager', leaderId: 'parent' }
const members = [{ id: 'parent', name: 'Parent' }, { id: 'daughter', name: 'Daughter' }]
const board = { household, members, tasks: [], fetchedAt: '2026-11-03T00:00:00Z' }
const boardState = { board, households: [household], pending: [], loading: false, refreshing: false, online: false, error: null }
const device = (revision = '0') => ({ accountId: 'parent', deviceId, revision, platform: 'android', permission: 'denied', hasToken: false, deviceName: 'Phone', appVersion: '1.0.0' })
const settings = (revision = '0', preferences = defaultNotificationPreferences('parent', 'Australia/Sydney')) => ({ accountId: 'parent', deviceId, householdId, revision, preferences, configured: revision !== '0' })
const registration = { platform: 'android', permission: 'denied', token: null, deviceName: 'Phone', appVersion: '1.0.0' }

class Database {
  constructor(filename) { this.db = new DatabaseSync(filename); this.tail = Promise.resolve(); this.failWrites = false }
  async execAsync(sql) { this.db.exec(sql) }
  async runAsync(sql, ...values) {
    if (this.failWrites && sql.startsWith('INSERT INTO native_notification_settings')) throw new Error('Simulated disk failure')
    return this.db.prepare(sql).run(...values)
  }
  async getFirstAsync(sql, ...values) { return this.db.prepare(sql).get(...values) ?? null }
  async getAllAsync(sql, ...values) { return this.db.prepare(sql).all(...values) }
  async withExclusiveTransactionAsync(work) {
    const result = this.tail.then(async () => { this.db.exec('BEGIN IMMEDIATE'); try { await work(this); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error } })
    this.tail = result.catch(() => {}); return result
  }
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-notification-sync-')), filename = path.join(dir, 'device.db')
  let db = new Database(filename), local = new LocalStore(db); await local.initialize(); await local.cacheBoard('parent', board)
  t.after(() => { db.db.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true }) })
  return { get db() { return db }, get local() { return local }, get store() { return local.notifications }, reopen: async () => {
    await db.tail; db.db.close(); db = new Database(filename); local = new LocalStore(db); await local.initialize()
  } }
}
function native() {
  return { inspect: async () => ({ permission: 'denied', canAskAgain: true }), requestPermission: async () => ({ permission: 'granted', canAskAgain: true }),
    details: () => ({ platform: 'android', deviceName: 'Phone', appVersion: '1.0.0' }), token: async () => 'ExpoPushToken[phone]', listenForTokenChange: () => () => {}, openSettings: async () => {} }
}
function backend() {
  let currentDevice = device(), currentSettings = settings()
  const sent = [], receipts = new Map()
  return { sent, get device() { return currentDevice }, get settings() { return currentSettings }, set settings(value) { currentSettings = value },
    notificationSettings: async scope => ({ device: currentDevice, settings: scope ? currentSettings : null }),
    saveNotificationSettings: async operation => {
      sent.push(structuredClone(operation))
      if (receipts.has(operation.operationId)) return receipts.get(operation.operationId)
      const current = operation.action === 'registerDevice' ? currentDevice : currentSettings
      if (operation.baseRevision !== current.revision) throw new TransportError('Settings changed', 409)
      const saved = operation.action === 'registerDevice'
        ? { ...currentDevice, revision: String(Number(current.revision) + 1), permission: operation.permission, hasToken: Boolean(operation.token) }
        : settings(String(Number(current.revision) + 1), operation.preferences)
      if (operation.action === 'registerDevice') currentDevice = saved; else currentSettings = saved
      receipts.set(operation.operationId, saved); return saved
    } }
}
async function until(predicate, label) {
  const deadline = Date.now() + 2000
  while (!predicate()) { if (Date.now() > deadline) assert.fail(`Timed out: ${label}`); await new Promise(resolve => setImmediate(resolve)) }
}

test('notification edits survive restart and retain newer choices behind an immutable in-flight request', async t => {
  const f = await fixture(t), first = defaultNotificationPreferences('parent', 'Australia/Sydney')
  first.categories.task_completed = { enabled: true, memberIds: ['daughter'] }
  await f.store.save('parent', householdId, first); await f.reopen()
  assert.deepEqual((await f.store.get('parent', householdId)).desired.categories.task_completed.memberIds, ['daughter'])
  await f.store.cache('parent', settings())
  const request = await f.store.prepare('parent', householdId, randomUUID())
  await f.store.save('parent', householdId, { ...first, showDetails: true })
  await f.reopen()
  assert.deepEqual(await f.store.prepare('parent', householdId, randomUUID()), request)
  await f.store.acknowledge('parent', householdId, request.operationId, settings('1', first))
  const second = await f.store.prepare('parent', householdId, randomUUID())
  assert.notEqual(second.operationId, request.operationId); assert.equal(second.baseRevision, '1'); assert.equal(second.preferences.showDetails, true)
  await f.store.acknowledge('parent', householdId, second.operationId, settings('2', second.preferences))
  assert.equal((await f.store.get('parent', householdId)).desired, null)
  await f.store.cache('parent', settings('1', first))
  assert.equal((await f.store.get('parent', householdId)).server.preferences.showDetails, true)
})

test('notification save and acknowledgement failures roll back, and household removal prevents late resurrection', async t => {
  const f = await fixture(t), preferences = defaultNotificationPreferences('parent', 'UTC')
  await f.store.cache('parent', settings())
  f.db.failWrites = true
  await assert.rejects(f.store.save('parent', householdId, preferences), /disk/)
  f.db.failWrites = false
  assert.equal((await f.store.get('parent', householdId)).desired, null)
  await f.store.save('parent', householdId, preferences)
  const request = await f.store.prepare('parent', householdId, randomUUID())
  f.db.failWrites = true
  await assert.rejects(f.store.acknowledge('parent', householdId, request.operationId, settings('1', preferences)), /disk/)
  f.db.failWrites = false
  assert.equal((await f.store.get('parent', householdId)).request.operationId, request.operationId)
  await f.store.save('other-account', householdId, preferences)
  await f.local.reconcileHouseholds('parent', [])
  await f.store.acknowledge('parent', householdId, request.operationId, settings('1', preferences))
  assert.equal((await f.store.all('parent')).length, 0)
  assert.ok((await f.store.get('other-account', householdId)).desired)
  await assert.rejects(f.store.cache('parent', settings('2')), /removed/)
})

test('a stale registration receipt cannot hide a newer revocation, and review cannot downgrade a cached revision', async t => {
  const f = await fixture(t), desired = { ...registration, permission: 'granted', token: 'ExpoPushToken[phone]' }
  await f.store.cache('parent', device())
  await f.store.save('parent', 'device', desired)
  const request = await f.store.prepare('parent', 'device', randomUUID())
  await f.store.cache('parent', device('2')) // Another signed-in account took over the installation.
  await f.store.acknowledge('parent', 'device', request.operationId, { ...device('1'), hasToken: true })
  await f.store.cache('parent', device('2'))
  await f.store.save('parent', 'device', desired)
  assert.deepEqual((await f.store.get('parent', 'device')).desired, desired, 'the still-signed-in account can register again')
  assert.equal((await f.store.prepare('parent', 'device', randomUUID())).baseRevision, '2')
  const prefs = defaultNotificationPreferences('parent', 'UTC')
  await f.store.cache('parent', settings('1', prefs)); await f.store.save('parent', householdId, { ...prefs, showDetails: true })
  const edit = await f.store.prepare('parent', householdId, randomUUID())
  await f.store.fail('parent', householdId, edit.operationId, 'Conflict', true, 1000)
  await f.store.cache('parent', settings('3', { ...prefs, enabled: false }))
  await f.store.retry('parent', householdId, settings('2', prefs))
  const retried = await f.store.prepare('parent', householdId, randomUUID())
  assert.equal(retried.baseRevision, '3')
  await f.store.fail('parent', householdId, retried.operationId, 'Conflict', true, 1000)
  await f.store.discard('parent', householdId, settings('2', prefs))
  const discarded = await f.store.get('parent', householdId)
  assert.equal(discarded.server.revision, '3'); assert.equal(discarded.confirmedDesired.enabled, false)
})

test('notification controls update before disk completes and revert if durable save fails', async t => {
  const f = await fixture(t), controller = new NotificationController(f.store, 'parent', {}, native(), randomUUID)
  t.after(() => controller.stop()); controller.observe(boardState); await controller.start()
  const save = f.store.save.bind(f.store); let release
  f.store.save = async (...args) => { await new Promise(resolve => { release = resolve }); return save(...args) }
  const pending = controller.changePreferences(preferences => ({ ...preferences, showDetails: true }))
  assert.equal(controller.getSnapshot().preferences.showDetails, true)
  assert.equal((await f.store.get('parent', householdId)).desired, null)
  release(); await pending; f.store.save = save
  f.db.failWrites = true
  await assert.rejects(controller.changePreferences(preferences => ({ ...preferences, showDetails: false })), /disk/)
  f.db.failWrites = false
  assert.equal(controller.getSnapshot().preferences.showDetails, true)
  assert.match(controller.getSnapshot().error, /could not be saved/)
})

test('a lost registration reply retries the same operation before uploading household preferences', async t => {
  const f = await fixture(t), api = backend(), send = api.saveNotificationSettings
  let loseReply = true, clock = 1000
  api.saveNotificationSettings = async operation => { const response = await send(operation); if (loseReply) { loseReply = false; throw new TransportError('Lost reply', 503) } return response }
  const controller = new NotificationController(f.store, 'parent', api, native(), randomUUID, () => clock)
  t.after(() => controller.stop()); controller.observe(boardState); await controller.start()
  await controller.changePreferences(preferences => ({ ...preferences, categories: { ...preferences.categories, task_completed: { enabled: true, memberIds: ['daughter'] } } }))
  controller.setConnectivity(true)
  await until(() => controller.getSnapshot().pending.some(row => row.scope === 'device' && row.attempts === 1), 'registration backoff')
  assert.equal(api.sent.length, 1)
  controller.setConnectivity(false); clock += 1_000_000; controller.setConnectivity(true)
  await until(() => api.sent.some(operation => operation.action === 'savePreferences') && controller.getSnapshot().pending.length === 0, 'reconnect flush')
  assert.equal(api.sent[0].operationId, api.sent[1].operationId)
  assert.deepEqual(api.settings.preferences.categories.task_completed.memberIds, ['daughter'])
})

test('a conflicting settings save waits for review and preserves the selected members', async t => {
  const f = await fixture(t), api = backend(), send = api.saveNotificationSettings
  let conflict = true
  api.saveNotificationSettings = async operation => {
    if (operation.action === 'savePreferences' && conflict) { conflict = false; api.settings = settings('1', { ...api.settings.preferences, showDetails: true }); throw new TransportError('Settings changed', 409) }
    return send(operation)
  }
  const controller = new NotificationController(f.store, 'parent', api, native(), randomUUID)
  t.after(() => controller.stop()); controller.observe(boardState); await controller.start()
  await controller.changePreferences(preferences => ({ ...preferences, categories: { ...preferences.categories, task_completed: { enabled: true, memberIds: ['daughter'] } } }))
  controller.setConnectivity(true)
  await until(() => controller.getSnapshot().pending.some(row => row.scope === householdId && row.state === 'rejected'), 'permanent conflict')
  const rejected = (await f.store.get('parent', householdId)).request
  await controller.refresh()
  assert.equal((await f.store.get('parent', householdId)).state, 'rejected')
  await controller.review(householdId)
  await until(() => controller.getSnapshot().pending.length === 0, 'reviewed preference upload')
  const sent = api.sent.find(operation => operation.action === 'savePreferences')
  assert.notEqual(sent.operationId, rejected.operationId); assert.equal(sent.baseRevision, '1')
  assert.deepEqual(api.settings.preferences.categories.task_completed.memberIds, ['daughter'])
})

test('stopping a notification runtime during upload retains its immutable request for the original account', async t => {
  const f = await fixture(t), api = backend(); let release
  api.saveNotificationSettings = async () => new Promise(resolve => { release = () => resolve(device('1')) })
  const controller = new NotificationController(f.store, 'parent', api, native(), randomUUID)
  controller.observe(boardState); await controller.start(); controller.setConnectivity(true)
  await until(() => Boolean(release), 'in-flight registration')
  controller.stop(); release()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok((await f.store.get('parent', 'device')).request)
  assert.equal((await f.store.all('other-account')).length, 0)
})

test('offline permission inspection preserves a queued token and repeated registration does not create new edits', async t => {
  const f = await fixture(t), adapter = native(), desired = { ...registration, permission: 'granted', token: 'ExpoPushToken[queued]' }
  await f.store.save('parent', 'device', desired)
  const version = (await f.store.get('parent', 'device')).editVersion
  adapter.inspect = async () => ({ permission: 'granted', canAskAgain: true })
  const controller = new NotificationController(f.store, 'parent', {}, adapter, randomUUID)
  t.after(() => controller.stop()); controller.observe(boardState); await controller.start()
  assert.deepEqual((await f.store.get('parent', 'device')).desired, desired)
  await f.store.save('parent', 'device', { token: desired.token, permission: desired.permission, ...adapter.details() })
  assert.equal((await f.store.get('parent', 'device')).editVersion, version)
  await f.store.cache('parent', device())
  const request = await f.store.prepare('parent', 'device', randomUUID())
  await f.store.acknowledge('parent', 'device', request.operationId, { ...device('1'), permission: 'granted', hasToken: true })
  await f.store.save('parent', 'device', { token: desired.token, permission: desired.permission, ...adapter.details() })
  assert.equal((await f.store.get('parent', 'device')).desired, null)
  assert.equal((await f.store.get('parent', 'device')).editVersion, version)
})

test('token lookup or native subscription failure does not disable an existing registration or stop settings sync', async t => {
  const f = await fixture(t), adapter = native(), api = backend()
  await f.store.cache('parent', { ...device('1'), permission: 'granted', hasToken: true })
  api.notificationSettings = async scope => ({ device: { ...device('1'), permission: 'granted', hasToken: true }, settings: scope ? api.settings : null })
  adapter.inspect = async () => ({ permission: 'granted', canAskAgain: true })
  adapter.token = async () => { throw new Error('Token service unavailable') }
  adapter.listenForTokenChange = () => { throw new Error('Native listener unavailable') }
  const controller = new NotificationController(f.store, 'parent', api, adapter, randomUUID)
  t.after(() => controller.stop()); controller.observe(boardState); await controller.start()
  await controller.changePreferences(preferences => ({ ...preferences, showDetails: true }))
  controller.setConnectivity(true)
  await until(() => api.sent.length && controller.getSnapshot().pending.length === 0, 'settings sync despite unavailable token service')
  assert.ok(api.sent.every(operation => operation.action === 'savePreferences'))
  assert.equal((await f.store.get('parent', 'device')).desired, null)
  assert.match(controller.getSnapshot().permissionError, /Token service/)
  assert.equal(api.settings.preferences.showDetails, true)
})

test('native notification adapter creates Android channels before asking permission and honors iOS provisional status', async () => {
  const events = [], permission = { status: 'denied', canAskAgain: true }, platform = { OS: 'android', Version: 37 }, constants = { expoConfig: { extra: { eas: { projectId: 'test-project' } } } }
  const intents = [], linking = { openSettings: async () => events.push('settings'), sendIntent: async (action, extras) => intents.push({action, extras}) }
  let tokenListener, tokenOptions, cleanupVersion = null, kiosk = false
  const notifications = {
    IosAuthorizationStatus: { AUTHORIZED: 2, DENIED: 1, PROVISIONAL: 3, EPHEMERAL: 4 }, IosAlertStyle: { NONE: 0, BANNER: 1, ALERT: 2 },
    AndroidImportance: { UNKNOWN: 0, UNSPECIFIED: 1, NONE: 2, MIN: 3, LOW: 4, DEFAULT: 5, HIGH: 6 }, AndroidNotificationVisibility: { PRIVATE: 2 },
    getNotificationChannelsAsync: async () => { events.push('read channels'); return [
      {id:'cyntch-task_completed',importance:2}, {id:'cyntch-member_added',importance:4}, {id:'cyntch-routine_generated',importance:5},
      {id:'cyntch-task_assigned',importance:6}, {id:'cyntch-member_left',importance:1}, {id:'other',importance:2},
    ] },
    getPermissionsAsync: async () => permission,
    setNotificationChannelAsync: async (id, options) => { assert.equal(options.sound, undefined, 'use the system default, not a missing custom sound'); events.push(id); return {id, ...options} }, requestPermissionsAsync: async () => { events.push('permission'); return { ...permission, status: 'granted' } },
    getExpoPushTokenAsync: async options => { tokenOptions = options; return { data: 'ExpoPushToken[adapter]' } },
    addPushTokenListener: listener => { tokenListener = listener; return { remove: () => events.push('removed') } },
    getLastNotificationResponse: () => null, getPresentedNotificationsAsync: async () => [],
    getAllScheduledNotificationsAsync: async () => [], unregisterForNotificationsAsync: async () => {},
  }
  const mocks = { 'expo-notifications': notifications, 'expo-constants': constants, 'expo-application': { nativeApplicationVersion: '1.0.0', applicationId:'com.cyntch.app' }, 'expo-device': { deviceName: 'Phone' }, 'react-native': { Platform: platform, Linking: linking } }
  const filename = path.join(root, 'mobile/src/services/notification-device.ts')
  const compiled = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', external: Object.keys(mocks), write: false })
  const loaded = new Module(filename, module); loaded.require = id => mocks[id] ?? require(id); loaded._compile(compiled.outputFiles[0].text, filename)
  const adapter = loaded.exports.createNotificationDevice({ active: async () => null, kioskRestricted: async () => kiosk, cleanupVersion: async () => cleanupVersion, completeCleanup: async () => { cleanupVersion = null } })
  assert.equal((await adapter.inspect()).permission, 'denied'); assert.equal(events.length, 0, 'inspection never prompts')
  assert.equal((await adapter.requestPermission()).permission, 'granted')
  assert.equal(events.at(-1), 'permission'); assert.equal(events.filter(value => value.startsWith('cyntch-')).length, 10, 'five existing categories are untouched')
  permission.ios = { status: 3 }; assert.equal((await adapter.inspect()).permission, 'provisional')
  permission.status = 'granted'; permission.ios.status = 1; assert.equal((await adapter.inspect()).permission, 'denied', 'iOS status takes precedence over generic permission')
  permission.ios = {status:2, allowsAlert:true, alertStyle:0, allowsDisplayInNotificationCenter:true}
  assert.deepEqual((await adapter.inspect()).iosPresentation, {alertsOff:true,centerOff:false})
  permission.ios = {status:2, allowsAlert:true, alertStyle:1, allowsDisplayInNotificationCenter:false}
  assert.deepEqual((await adapter.inspect()).iosPresentation, {alertsOff:false,centerOff:true})
  permission.ios = {status:2, allowsAlert:null, allowsDisplayInNotificationCenter:null}
  assert.deepEqual((await adapter.inspect()).iosPresentation, {alertsOff:false,centerOff:false}, 'unknown settings must not create warnings')
  platform.Version = 24
  const beforeLegacyRead = events.length
  assert.deepEqual(await adapter.channelRestrictions(), {}); assert.equal(events.length, beforeLegacyRead, 'Android 24 has no channels')
  platform.Version = 37
  assert.deepEqual(await adapter.channelRestrictions(), {task_completed:'blocked',member_added:'lower-priority',routine_generated:'lower-priority'})
  await adapter.openSettings('task_completed')
  assert.deepEqual(intents[0], {action:'android.settings.CHANNEL_NOTIFICATION_SETTINGS',extras:[
    {key:'android.provider.extra.APP_PACKAGE',value:'com.cyntch.app'}, {key:'android.provider.extra.CHANNEL_ID',value:'cyntch-task_completed'}]})
  await adapter.openSettings(); assert.equal(intents[1].action,'android.settings.APP_NOTIFICATION_SETTINGS')
  linking.sendIntent=async()=>{throw new Error('No matching settings activity')}
  const remove = adapter.listenForTokenChange(() => events.push('rotated')), nativeToken = { type: 'android', data: 'rolled-native-token' }
  tokenListener(nativeToken); await adapter.token(); assert.deepEqual(tokenOptions.devicePushToken, nativeToken, 'token listener does not trigger recursive native token requests')
  cleanupVersion = 1; await adapter.token()
  assert.equal(tokenOptions.devicePushToken, undefined, 'a token observed before native cleanup must be reacquired')
  remove(); await adapter.openSettings(); assert.equal(events.at(-1), 'settings')
  kiosk = true
  await assert.rejects(adapter.token(), /Unlock kiosk/)
  await assert.rejects(adapter.requestPermission(), /Unlock kiosk/)
  constants.expoConfig.extra.eas.projectId = null; await assert.rejects(adapter.token(), /not available in this build/)
})

test('already-authorized Android registration creates missing channels without resetting user choices or asking permission', async () => {
  const platform = { OS: 'android', Version: 32 }, channels = new Map(), created = [], tokenSnapshots = []
  let failChannel = null, channelReads = 0, kiosk = false
  const notifications = {
    AndroidImportance: { HIGH: 6 }, AndroidNotificationVisibility: { PRIVATE: 2 },
    getPermissionsAsync: async () => ({ status: 'granted', canAskAgain: true }),
    requestPermissionsAsync: async () => { throw new Error('Already-authorized registration must not prompt') },
    getNotificationChannelsAsync: async () => { channelReads++; return [...channels.values()] },
    setNotificationChannelAsync: async (id, options) => {
      if (id === failChannel) throw new Error('Native channel creation failed')
      assert(!channels.has(id), 'existing user settings must be preserved')
      const channel = { id, ...options }; channels.set(id, channel); created.push(id); return channel
    },
    getExpoPushTokenAsync: async () => { tokenSnapshots.push([...channels.keys()].sort()); return { data: 'ExpoPushToken[existing-permission]' } },
  }
  const mocks = { 'expo-notifications': notifications,
    'expo-constants': { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
    'expo-application': {}, 'expo-device': {}, 'react-native': { Platform: platform, Linking: {} } }
  const filename = path.join(root, 'mobile/src/services/notification-device.ts')
  const bundle = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', external: Object.keys(mocks), write: false })
  const adapterModule = new Module(filename, module)
  adapterModule.require = id => mocks[id] ?? require(id); adapterModule._compile(bundle.outputFiles[0].text, filename)
  const adapter = adapterModule.exports.createNotificationDevice({ kioskRestricted: async () => kiosk, cleanupVersion: async () => null })
  const expected = Object.keys(loaded.exports.notificationCatalog).map(kind => 'cyntch-' + kind).sort()
  assert.equal((await adapter.inspect()).permission, 'granted')
  assert.equal(channelReads, 0, 'reading permission has no channel side effects')
  assert.equal(created.length, 0)
  assert.equal(await adapter.token(), 'ExpoPushToken[existing-permission]')
  assert.deepEqual(tokenSnapshots[0], expected, 'all categories must exist before the provider token is obtained')
  const blocked = { id: 'cyntch-task_completed', importance: 2, name: 'User-controlled channel' }
  channels.set(blocked.id, blocked)
  await adapter.token()
  assert.equal(created.length, expected.length, 'a repeat registration creates no channels')
  assert.deepEqual(channels.get(blocked.id), blocked)
  channels.delete('cyntch-routine_generated')
  failChannel = 'cyntch-routine_generated'
  await assert.rejects(adapter.token(), /Native channel creation failed/)
  assert.equal(tokenSnapshots.length, 2, 'failed channel setup cannot register a token prematurely')
  failChannel = null
  await adapter.token()
  assert.deepEqual(tokenSnapshots[2], expected, 'a retry finishes only the missing category')
  assert.equal(created.length, expected.length + 1)
  const beforeReads = channelReads
  platform.Version = 24
  await adapter.token()
  assert.equal(channelReads, beforeReads, 'pre-channel Android versions do not use channel APIs')
  platform.OS = 'ios'; platform.Version = '26.5'
  await adapter.token()
  assert.equal(channelReads, beforeReads, 'iOS does not use Android channel APIs')
  kiosk = true; platform.OS = 'android'; platform.Version = 32
  await assert.rejects(adapter.token(), /Unlock kiosk/)
  assert.equal(channelReads, beforeReads, 'restricted devices cannot configure channels')
  const beforeTokens = tokenSnapshots.length
  notifications.getNotificationChannelsAsync = async () => { kiosk = true; return [...channels.values()] }
  kiosk = false
  await assert.rejects(adapter.token(), /Unlock kiosk/)
  assert.equal(tokenSnapshots.length, beforeTokens, 'a lock enabled during channel setup prevents provider registration')
  kiosk = false
  await assert.rejects(adapter.requestPermission(), /Unlock kiosk/, 'a lock enabled during setup also prevents the system prompt')
})
