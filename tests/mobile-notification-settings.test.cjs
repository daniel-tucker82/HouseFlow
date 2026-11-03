/* eslint-disable @typescript-eslint/no-require-imports -- Validate the shared native notification contract in Node. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { randomUUID } = require('node:crypto')
const filename = path.resolve(__dirname, '../shared/mobile/notification-settings.ts')
const compiled = buildSync({ stdin: { contents: `export * from ${JSON.stringify(filename)}; export * from ${JSON.stringify(path.resolve(__dirname, '../shared/mobile/notification-catalog.ts'))};`, resolveDir: __dirname }, bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = new Module(filename, module); loaded._compile(compiled.outputFiles[0].text, filename)
const { parseNotificationPreferences, parseNotificationSettingsOperation, restrictNotificationPreferences, defaultNotificationPreferences, shouldPushNotification } = loaded.exports

test('notification settings validate tokens, permissions, revisions, categories, members and quiet hours', () => {
  const registration = { action: 'registerDevice', operationId: randomUUID(), baseRevision: '0', platform: 'android', permission: 'granted', token: 'ExpoPushToken[test-device]', deviceName: 'Kitchen', appVersion: '1.0.0' }
  assert.equal(parseNotificationSettingsOperation(registration).token, registration.token)
  for (const patch of [{ token: 'raw-fcm-token' }, { permission: 'denied' }, { permission: 'provisional' }, { baseRevision: '01' }, { baseRevision: '9223372036854775807' }, { operationId: 'bad' }, { platform: 'web' }]) assert.throws(() => parseNotificationSettingsOperation({ ...registration, ...patch }))
  assert.equal(parseNotificationSettingsOperation({ ...registration, platform: 'ios', permission: 'provisional' }).permission, 'provisional')
  assert.equal(parseNotificationSettingsOperation({ ...registration, token: null, permission: 'denied' }).token, null)
  const preferences = defaultNotificationPreferences('parent', 'Australia/Sydney')
  preferences.categories.task_completed = { enabled: true, memberIds: ['son', 'daughter', 'son'] }
  assert.deepEqual(parseNotificationPreferences(preferences).categories.task_completed.memberIds, ['daughter', 'son'])
  for (const patch of [{ enabled: 'yes' }, { timezone: 'Invalid/Zone' }, { quietHours: { start: '24:00', end: '07:00' } }, { categories: { accidental_category: { enabled: true, memberIds: [] } } }, { categories: { task_completed: { enabled: true, memberIds: [null] } } }, { categories: { routine_generated: { enabled: true, memberIds: ['child'] } } }]) assert.throws(() => parseNotificationPreferences({ ...preferences, ...patch }))
})

test('current role and membership restrict saved choices without changing another device preference object', () => {
  const phone = defaultNotificationPreferences('parent', 'Australia/Sydney'), tablet = defaultNotificationPreferences('parent', 'Australia/Sydney', true)
  phone.categories.task_completed = { enabled: true, memberIds: ['parent', 'daughter', 'removed'] }
  phone.categories.member_added = { enabled: true, memberIds: [] }
  phone.categories.routine_completed = { enabled: true, memberIds: [] }
  const restricted = restrictNotificationPreferences(phone, 'parent', 'member', ['parent', 'daughter'])
  assert.deepEqual(restricted.categories.task_completed.memberIds, ['parent'])
  assert.equal(restricted.categories.member_added.enabled, false)
  assert.equal(restricted.categories.routine_completed.enabled, false)
  assert.equal(phone.categories.member_added.enabled, true)
  assert.equal(tablet.enabled, false)
  const supervisor = restrictNotificationPreferences(phone, 'parent', 'supervisor', ['parent', 'daughter'])
  assert.equal(supervisor.categories.member_added.enabled, false)
  assert.equal(supervisor.categories.routine_completed.enabled, true)
  assert.deepEqual(supervisor.categories.task_completed.memberIds, ['parent', 'daughter'])
  assert.equal(shouldPushNotification({ kind: 'task_completed', memberIds: ['daughter'], userId: 'parent', role: 'manager', preferences: supervisor, now: new Date('2026-11-03T12:00:00Z') }), true)
})
