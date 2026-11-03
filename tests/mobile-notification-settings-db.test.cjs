/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL transactions with authenticated route fixtures. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID, randomBytes } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { transformSync, buildSync } = require('esbuild')
const { Pool } = require('pg')
const url = process.env.CYNTCH_TEST_DATABASE_URL

test('native notification settings isolate devices/households/accounts and safely replay interrupted registrations and preference saves', { skip: !url }, async t => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
  const schema = `native_notifications_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`create schema ${schema}`)
  const db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 6 })
  t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  await db.query(`create table users(id text primary key); create table households(id uuid primary key,timezone text);
    create table household_members(household_id uuid,user_id text,role text,primary key(household_id,user_id))`)
  const migration = readFileSync(path.resolve(__dirname, '../database/0024_native_notification_settings.sql'), 'utf8')
  await db.query(migration); await db.query(migration)
  await db.query("insert into users values('parent'),('other'),('daughter'),('son')")
  const household = randomUUID(), secondHousehold = randomUUID(), privateHousehold = randomUUID(), phone = randomUUID(), tablet = randomUUID()
  await db.query("insert into households values($1,'Australia/Sydney'),($2,'UTC'),($3,'UTC')", [household, secondHousehold, privateHousehold])
  await db.query("insert into household_members values($1,'parent','manager'),($1,'daughter','member'),($1,'son','member'),($2,'parent','manager'),($3,'other','manager')", [household, secondHousehold, privateHousehold])
  let userId = 'parent'
  const mocks = { '@/lib/db': { db }, '@clerk/nextjs/server': { auth: async () => ({ userId }) },
    '@/lib/household-authz': { normalizeRole: role => role === 'leader' ? 'manager' : role },
    '@/lib/usage-controls': { enforceRequestLimit: async () => {} }, '@/lib/user-sync': { ensureCurrentUserRecord: async () => {} },
    '@/lib/entitlements': { EntitlementError: class extends Error {} } }
  function load(relative, bundle = false) {
    const filename = path.resolve(__dirname, '..', relative), loaded = new Module(filename, module)
    loaded.require = id => mocks[id] ?? require(id)
    const code = bundle ? buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text : transformSync(readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code
    loaded._compile(code, filename); return loaded.exports
  }
  mocks['@/shared/mobile/notification-catalog'] = load('shared/mobile/notification-catalog.ts', true)
  mocks['@/shared/mobile/notification-settings'] = load('shared/mobile/notification-settings.ts', true)
  mocks['@/lib/native-notification-settings'] = load('lib/native-notification-settings.ts')
  const { defaultNotificationPreferences } = mocks['@/shared/mobile/notification-catalog']
  const route = load('app/api/mobile/notifications/route.ts')
  const secrets = new Map()
  function secret(deviceId) { if (!secrets.has(deviceId)) secrets.set(deviceId, randomBytes(32).toString('hex')); return secrets.get(deviceId) }
  async function post(deviceId, body, account = userId, installationSecret = secret(deviceId)) {
    const response = await route.POST(new Request('http://localhost/api/mobile/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Task-Save-User': account, 'X-Cyntch-Device': deviceId, 'X-Cyntch-Installation': installationSecret }, body: JSON.stringify(body) }))
    return { status: response.status, data: await response.json() }
  }
  async function get(deviceId, householdId) {
    const response = await route.GET(new Request(`http://localhost/api/mobile/notifications${householdId ? `?householdId=${householdId}` : ''}`, { headers: { 'X-Task-Save-User': userId ?? '', 'X-Cyntch-Device': deviceId, 'X-Cyntch-Installation': secret(deviceId) } }))
    assert.equal(response.headers.get('cache-control'), response.status === 401 ? null : 'no-store')
    return { status: response.status, data: await response.json() }
  }
  const register = (token, baseRevision = '0') => ({ action: 'registerDevice', operationId: randomUUID(), baseRevision, platform: 'android', permission: 'granted', token, deviceName: 'Test device', appVersion: '1.0.0' })
  const save = (preferences, householdId = household, baseRevision = '0') => ({ action: 'savePreferences', operationId: randomUUID(), baseRevision, householdId, preferences })
  assert.equal((await get(phone, household)).data.settings.preferences.enabled, false, 'no registration implies no push')
  assert.equal((await db.query('select count(*) from native_notification_devices')).rows[0].count, '0', 'reads do not register a device')
  const phoneRegistration = register('ExpoPushToken[phone]')
  assert.equal((await post(phone, phoneRegistration)).status, 200)
  assert.equal((await post(phone, phoneRegistration)).data.replayed, true)
  assert.equal((await post(phone, phoneRegistration, userId, randomBytes(32).toString('hex'))).status, 403, 'device IDs alone cannot replay or transfer a registration')
  assert.equal((await post(tablet, register('ExpoPushToken[tablet]'))).status, 200)
  const initial = (await get(phone, household)).data
  assert.equal(initial.device.revision, '1'); assert.equal(initial.settings.preferences.enabled, true)
  assert.equal(initial.settings.preferences.categories.task_available.enabled, true)
  assert.equal(initial.settings.preferences.categories.task_completed.enabled, false)
  assert.equal(initial.device.token, undefined, 'registration tokens are never returned to clients')

  const chosen = defaultNotificationPreferences('parent', 'Australia/Sydney')
  chosen.categories.task_completed = { enabled: true, memberIds: ['daughter'] }
  chosen.categories.routine_generated = { enabled: true, memberIds: [] }
  chosen.categories.routine_superseded = { enabled: true, memberIds: [] }
  chosen.categories.member_added = { enabled: true, memberIds: [] }
  chosen.quietHours = { start: '22:00', end: '07:00' }
  const first = save(chosen)
  const simultaneous = await Promise.all([post(phone, first), post(phone, first)])
  assert.ok(simultaneous.every(result => result.status === 200))
  assert.equal(simultaneous.filter(result => result.data.replayed).length, 1)
  assert.equal((await get(phone, household)).data.settings.revision, '1')
  assert.deepEqual((await get(phone, household)).data.settings.preferences.categories.task_completed.memberIds, ['daughter'])
  assert.equal((await get(tablet, household)).data.settings.preferences.categories.task_completed.enabled, false)
  assert.equal((await get(phone, secondHousehold)).data.settings.configured, false)
  assert.equal((await get(phone, privateHousehold)).status, 403)
  assert.equal((await post(phone, { ...first, preferences: { ...chosen, enabled: false } })).status, 409, 'operation IDs are immutable')
  const newer = save({ ...chosen, enabled: false }, household, '1')
  assert.equal((await post(phone, newer)).status, 200)
  assert.equal((await post(phone, first)).data.replayed, true)
  assert.equal((await get(phone, household)).data.settings.preferences.enabled, false, 'late replay does not revert a newer choice')
  assert.equal((await post(phone, save(defaultNotificationPreferences('parent', 'UTC'), secondHousehold))).status, 200)
  assert.equal((await get(phone, secondHousehold)).data.settings.preferences.enabled, true)
  assert.equal((await get(phone, household)).data.settings.preferences.enabled, false, 'saving a second household leaves the first unchanged')
  assert.equal((await post(phone, save(chosen, household, '1'))).status, 409, 'a stale version cannot overwrite newer choices')
  assert.equal((await post(phone, save({ ...chosen, categories: { ...chosen.categories, task_completed: { enabled: true, memberIds: ['other'] } } }, household, '2'))).status, 403)
  assert.equal((await post(phone, first, 'other')).status, 403, 'a queued request cannot cross signed-in accounts')

  await db.query("update household_members set role='member' where household_id=$1 and user_id='parent'", [household])
  const downgraded = (await get(phone, household)).data.settings.preferences
  assert.equal(downgraded.categories.member_added.enabled, false)
  assert.deepEqual(downgraded.categories.task_completed.memberIds, [])
  assert.equal((await post(phone, first)).data.settings.preferences.categories.member_added.enabled, false, 'replay follows current access')
  assert.equal((await post(phone, save(chosen, household, '2'))).status, 403)
  await db.query("delete from household_members where household_id=$1 and user_id='parent'", [household])
  assert.equal((await post(phone, first)).status, 403, 'receipts cannot bypass membership revocation')

  const denied = { ...register(null, '1'), permission: 'denied' }
  assert.equal((await post(phone, denied)).status, 200)
  assert.equal((await post(phone, phoneRegistration)).data.replayed, true)
  assert.equal((await get(phone)).data.device.hasToken, false, 'a replay cannot reactivate a denied token')
  const phoneReturn = register('ExpoPushToken[phone-rotated]', '2')
  assert.equal((await post(phone, phoneReturn)).status, 200)
  userId = 'other'
  assert.equal((await post(phone, register('ExpoPushToken[stolen-id]'), userId, randomBytes(32).toString('hex'))).status, 403, 'another account cannot deactivate a known device ID without its installation secret')
  assert.equal((await get(phone)).data.device.revision, '0', 'new account has independent device registration')
  assert.equal((await post(phone, register('ExpoPushToken[other-account]'))).status, 200)
  userId = 'parent'
  assert.equal((await get(phone)).data.device.hasToken, false, 'account switch deactivates the previous account even if its token changed')
  assert.equal((await post(phone, register('ExpoPushToken[phone-rotated]', '3'))).status, 409, 'a delayed old-account write cannot reclaim this installation')
  assert.equal((await post(phone, phoneReturn)).data.replayed, true)
  assert.equal((await get(phone)).data.device.hasToken, false)
  userId = 'other'
  const replacement = randomUUID()
  assert.equal((await post(replacement, register('ExpoPushToken[tablet]'))).status, 200)
  userId = 'parent'
  assert.equal((await get(tablet)).data.device.hasToken, false, 'token transfer cannot deliver to two accounts')
  assert.equal((await post(tablet, register('ExpoPushToken[tablet]', '1'))).status, 409)

  const rollbackDevice = randomUUID()
  await db.query(`create function reject_native_receipt() returns trigger language plpgsql as $$ begin raise exception 'simulated receipt failure'; end $$;
    create trigger native_receipt_failure before insert on native_notification_operations for each row execute function reject_native_receipt()`)
  const errorLog = console.error; console.error = () => {}
  try { assert.equal((await post(rollbackDevice, register('ExpoPushToken[rollback]'))).status, 503) }
  finally { console.error = errorLog }
  assert.equal((await get(rollbackDevice)).data.device.revision, '0', 'receipt failure rolls back the registration too')
  await db.query('drop trigger native_receipt_failure on native_notification_operations')
  assert.equal((await post(rollbackDevice, register('ExpoPushToken[rollback]'))).status, 200)
  const beforeFailure = defaultNotificationPreferences('parent', 'UTC')
  assert.equal((await post(rollbackDevice, save(beforeFailure, secondHousehold))).status, 200)
  await db.query('create trigger native_receipt_failure before insert on native_notification_operations for each row execute function reject_native_receipt()')
  console.error = () => {}
  try { assert.equal((await post(rollbackDevice, save({ ...beforeFailure, enabled: false }, secondHousehold, '1'))).status, 503) }
  finally { console.error = errorLog }
  const unchanged = (await get(rollbackDevice, secondHousehold)).data.settings
  assert.equal(unchanged.revision, '1'); assert.equal(unchanged.preferences.enabled, true, 'receipt failure rolls back preferences and their version together')
  await db.query('drop trigger native_receipt_failure on native_notification_operations')
  assert.equal((await post('invalid-device', register('ExpoPushToken[invalid]'))).status, 400)
  userId = null; assert.equal((await get(phone)).status, 401)
})
