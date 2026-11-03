/* eslint-disable @typescript-eslint/no-require-imports -- Real PostgreSQL expansion, access checks and interruption recovery. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID, createHash } = require('node:crypto')
const { readFileSync, readdirSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { buildSync } = require('esbuild')
const { Pool } = require('pg')
const url = process.env.CYNTCH_TEST_DATABASE_URL
function load(relative) {
  const filename = path.resolve(__dirname, '..', relative), loaded = new Module(filename, module)
  loaded.require = id => require(id)
  loaded._compile(buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external' }).outputFiles[0].text, filename)
  return loaded.exports
}
const { expandNativeNotificationEvents: expand, claimNativeNotificationDeliveries: claim } = load('lib/native-notification-outbox.ts')
const { defaultNotificationPreferences } = load('shared/mobile/notification-catalog.ts')
const { parseNativeNotificationPayload } = load('shared/mobile/notification-payload.ts')
const { processNativeNotifications: drain } = load('lib/native-notification-worker.ts')

async function fixture(t) {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
  const schema = `native_outbox_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url })
  await admin.query(`create schema ${schema}`)
  const db = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 6 })
  t.after(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end() })
  for (const name of ['app_role', 'routine_type', 'task_status', 'occurrence_status', 'notification_kind']) {
    const labels = (await admin.query(`select e.enumlabel from pg_enum e join pg_type p on p.oid=e.enumtypid join pg_namespace n on n.oid=p.typnamespace
      where p.typname=$1 and n.nspname='public' order by e.enumsortorder`, [name])).rows
    if (labels.length) await db.query(`create type ${name} as enum (${labels.map(row => "'" + row.enumlabel.replaceAll("'", "''") + "'").join(',')})`)
  }
  const dir = path.resolve(__dirname, '../database')
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) await db.query(readFileSync(path.join(dir, file), 'utf8'))
  await db.query(readFileSync(path.join(dir, '0026_native_notification_deliveries.sql'), 'utf8'))
  const household = randomUUID(), other = randomUUID(), routine = randomUUID(), occurrence = randomUUID(), task = randomUUID()
  await db.query("insert into users(id,full_name) values('parent','Parent'),('child','Alex'),('supervisor','Taylor'),('outsider','Stranger')")
  await db.query("insert into households(id,name,leader_id) values($1,'Private family','parent'),($2,'Other family','outsider')", [household, other])
  await db.query("insert into household_members(household_id,user_id,role) values($1,'parent','manager'),($1,'child','member'),($1,'supervisor','supervisor'),($2,'outsider','manager')", [household, other])
  const devices = {}
  async function device(name, user = name, permission = 'granted') {
    const id = randomUUID()
    await db.query("insert into native_notification_installations(device_id,secret_hash) values($1,repeat('a',64))", [id])
    await db.query("insert into native_notification_devices(user_id,device_id,platform,permission,expo_push_token,session_id) values($1,$2,'android',$3,$4,$5)", [user, id, permission, permission === 'denied' ? null : `ExpoPushToken[${name}]`, `sess_${user}`])
    devices[name] = id
    return id
  }
  const parentPreferences = defaultNotificationPreferences('parent', 'Australia/Sydney')
  for (const [kind, selection] of Object.entries(parentPreferences.categories)) {
    selection.enabled = true
    selection.memberIds = kind.startsWith('task_') || kind.startsWith('reward_') ? ['child'] : []
  }
  parentPreferences.categories.task_assigned.enabled = false
  async function preferences(name, value, user = name, hh = household) {
    await db.query(`insert into native_notification_preferences(user_id,device_id,household_id,preferences) values($1,$2,$3,$4)
      on conflict(user_id,device_id,household_id) do update set preferences=excluded.preferences`, [user, devices[name], hh, JSON.stringify(value)])
  }
  for (const name of ['parent','child','supervisor','outsider']) await device(name)
  await device('tablet', 'parent')
  await preferences('parent', parentPreferences)
  await preferences('tablet', { ...parentPreferences, enabled: false }, 'parent')
  await preferences('supervisor', parentPreferences)
  await preferences('outsider', parentPreferences) // Deliberately stale/corrupt cross-household configuration.
  await db.query('delete from native_notification_events')
  await db.query("insert into routines(id,household_id,name) values($1,$2,'Private morning routine')", [routine, household])
  const client = await db.connect()
  try {
    await client.query('begin')
    await client.query("insert into routine_occurrences(id,household_id,routine_id,kind,scheduled_for) values($1,$2,$3,'routine',now())", [occurrence, household, routine])
    await client.query("insert into tasks(id,household_id,routine_id,routine_occurrence_id,title,assignee_id) values($1,$2,$3,$4,'Private pack bag','child')", [task, household, routine, occurrence])
    await client.query("insert into occurrence_tasks(occurrence_id,task_id,status) values($1,$2,'unlocked')", [occurrence, task])
    await client.query('commit')
  } finally { client.release() }
  const onlyAvailability = () => db.query("delete from native_notification_events where kind<>'task_available'")
  const jobs = async () => (await db.query('select * from native_notification_deliveries order by id')).rows
  return { db, schema, household, occurrence, task, devices, device, preferences, parentPreferences, onlyAvailability, jobs }
}

test('native outbox independently selects devices, filters household access and roles, and keeps private payloads private', { skip: !url }, async t => {
  const f = await fixture(t)
  // Supervisor can monitor tasks and runs, but cannot receive manager-only membership events.
  await f.db.query("insert into users(id,full_name) values('new_child','New child')")
  await f.db.query("insert into household_members(household_id,user_id,role) values($1,'new_child','member')", [f.household])
  const results = await Promise.all([expand(f.db), expand(f.db)])
  assert.equal(results.reduce((n, result) => n + result.queued, 0), 6)
  const claims = (await Promise.all([claim(f.db), claim(f.db)])).flat()
  assert.equal(claims.length, 6)
  assert.equal(new Set(claims.map(job => job.id)).size, 6)
  assert.ok(claims.every(job => !job.message.to.includes('tablet') && !job.message.to.includes('outsider')))
  assert.deepEqual(claims.filter(job => job.message.data.kind === 'member_added').map(job => job.message.data.accountId), ['parent'])
  assert.equal(claims.filter(job => job.message.data.kind === 'routine_started').length, 2)
  assert.equal(claims.filter(job => job.message.data.kind === 'task_available').length, 3)
  for (const { id, message } of claims) {
    assert.equal(message.data.version, 3)
    assert.deepEqual(parseNativeNotificationPayload(message.data), message.data, 'server payload must pass the native parser')
    const selection = message.data.kind === 'task_available' ? ['child'] : null
    assert.equal(message.data.memberSelectionHash, selection ? createHash('sha256').update(JSON.stringify(selection)).digest('hex') : null)
    assert.equal(message.data.hasDetails, false)
    assert.equal(message.data.sessionId, `sess_${message.data.accountId}`)
    assert.equal(message.channelId, `cyntch-${message.data.kind}`)
    assert.equal(message.collapseId, id); assert.equal(message.tag, id)
    assert.ok(!JSON.stringify(message).includes('Private') && !JSON.stringify(message).includes('New child'))
    assert.ok(message.ttl > 0 && message.ttl <= 86400)
  }
  assert.deepEqual(await claim(f.db), [], 'another worker cannot claim an unexpired lease')
})

test('native outbox rechecks revocation, permission, quiet hours and stale task state immediately before claiming', { skip: !url }, async t => {
  const mutations = {
    disabled: f => f.preferences('parent', { ...f.parentPreferences, enabled: false }),
    quiet: f => f.preferences('parent', { ...f.parentPreferences, quietHours: { start: '22:00', end: '22:00' } }),
    permission: f => f.db.query("update native_notification_devices set permission='denied',expo_push_token=null where user_id='parent'"),
    signedOut: f => f.db.query("update native_notification_devices set session_id=null where user_id='parent'"),
    newSession: f => f.db.query("update native_notification_devices set session_id='sess_new_login' where user_id='parent'"),
    revoked: f => f.db.query("delete from household_members where household_id=$1 and user_id='parent'", [f.household]),
    demoted: f => f.db.query("update household_members set role='member' where household_id=$1 and user_id='parent'", [f.household]),
    invalid: f => f.preferences('parent', { ...f.parentPreferences, timezone: 'Invalid/Zone' }),
  }
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async sub => {
    const f = await fixture(sub)
    await f.onlyAvailability(); await expand(f.db); await mutate(f)
    const claimed = await claim(f.db)
    assert.ok(!claimed.some(job => job.message.data.accountId === 'parent'))
    assert.equal((await f.jobs()).filter(job => job.user_id === 'parent')[0].state, 'suppressed')
    assert.equal(claimed.length, 2, 'other eligible household members keep their own settings')
  })
  for (const stale of ['completed','cancelled','deleted','expired']) await t.test(stale, async sub => {
    const f = await fixture(sub)
    await f.onlyAvailability(); await expand(f.db)
    if (stale === 'completed') await f.db.query("update occurrence_tasks set status='completed' where task_id=$1", [f.task])
    else if (stale === 'cancelled') await f.db.query("update routine_occurrences set status='cancelled' where id=$1", [f.occurrence])
    else if (stale === 'deleted') await f.db.query('delete from routine_occurrences where id=$1', [f.occurrence])
    else await f.db.query("update native_notification_events set expires_at=now()-interval '1 second'")
    assert.deepEqual(await claim(f.db), [])
    assert.ok((await f.jobs()).every(job => job.state === (stale === 'expired' ? 'expired' : 'suppressed')))
  })
})

test('native outbox rolls back expansion, resumes crashed leases and uses current privacy/token on retry', { skip: !url }, async t => {
  const f = await fixture(t)
  await f.onlyAvailability()
  await f.device('late', 'parent')
  await f.preferences('late', f.parentPreferences, 'parent')
  await f.db.query(`create function interrupt_expansion() returns trigger language plpgsql as $$ begin raise exception 'Interrupted expansion'; end $$;
    create trigger fail_expansion before insert on native_notification_deliveries for each row execute function interrupt_expansion()`)
  await assert.rejects(expand(f.db), /Interrupted expansion/)
  assert.equal((await f.jobs()).length, 0)
  assert.equal((await f.db.query('select state from native_notification_events')).rows[0].state, 'pending')
  await f.db.query('drop trigger fail_expansion on native_notification_deliveries')
  await expand(f.db)
  assert.equal((await f.jobs()).length, 3, 'a newly installed device cannot receive earlier events')
  await f.preferences('parent', { ...f.parentPreferences, showDetails: true })
  const original = (await claim(f.db)).find(job => job.message.data.accountId === 'parent')
  assert.match(original.message.body, /Private pack bag/)
  await f.preferences('parent', f.parentPreferences)
  await f.db.query("update native_notification_devices set expo_push_token='ExpoPushToken[rotated]' where user_id='parent' and device_id=$1", [f.devices.parent])
  await f.db.query("update native_notification_deliveries set lease_until=now()-interval '1 second' where id=$1", [original.id])
  const restarted = new Pool({ connectionString: url, options: `-c search_path=${f.schema}` })
  let retried
  try { retried = (await claim(restarted))[0] } finally { await restarted.end() }
  assert.equal(retried.id, original.id)
  assert.notEqual(retried.leaseId, original.leaseId)
  assert.equal(retried.message.to, 'ExpoPushToken[rotated]')
  assert.ok(!retried.message.body.includes('Private'))
  assert.equal(retried.message.collapseId, original.message.collapseId)
  assert.equal((await f.jobs()).find(job => job.id === original.id).attempts, 2)
})

test('push tickets survive restarts, receipts never resend accepted messages, and old-token failures cannot revoke a new token', { skip: !url }, async t => {
  const f = await fixture(t)
  await f.onlyAvailability()
  const sent = []
  const provider = {
    async send(messages) { sent.push(...messages); return messages.map(message => ({ status: 'ok', id: `ticket_${message.data.accountId}` })) },
    async receipts() { return { ticket_parent: { status: 'ok' }, ticket_child: { status: 'error', code: 'DeviceNotRegistered' } } },
  }
  await Promise.all([drain(f.db, provider), drain(f.db, provider)])
  assert.equal(sent.length, 3)
  assert.ok((await f.jobs()).every(job => job.state === 'awaiting_receipt' && job.ticket_id))
  await drain(f.db, provider)
  assert.equal(sent.length, 3, 'accepted tickets wait for receipt time instead of being sent again')
  await f.db.query("update native_notification_devices set expo_push_token='ExpoPushToken[new_child_token]' where user_id='child'")
  await f.db.query("update native_notification_deliveries set next_attempt_at=now()-interval '1 second'")
  await drain(f.db, provider)
  assert.equal(sent.length, 3)
  const jobs = await f.jobs()
  assert.equal(jobs.find(job => job.user_id === 'parent').state, 'provider_accepted')
  assert.equal(jobs.find(job => job.user_id === 'child').last_error_code, 'DeviceNotRegistered')
  assert.equal((await f.db.query("select expo_push_token from native_notification_devices where user_id='child'")).rows[0].expo_push_token, 'ExpoPushToken[new_child_token]')
  assert.equal(jobs.find(job => job.user_id === 'supervisor').state, 'awaiting_receipt')
  await f.db.query("update native_notification_deliveries set accepted_at=now()-interval '25 hours',next_attempt_at=now()-interval '1 second' where state='awaiting_receipt'")
  await drain(f.db, { ...provider, async receipts() { throw new Error('Provider unavailable') } })
  assert.equal((await f.jobs()).find(job => job.user_id === 'supervisor').last_error_code, 'ReceiptUnavailable')
  assert.equal(sent.length, 3, 'an unknown receipt remains unknown, without generating another banner')
})

test('provider outages persist backoff, retries keep delivery identities, and invalid tokens stop further sends', { skip: !url }, async t => {
  const f = await fixture(t)
  await f.onlyAvailability()
  const batches = []
  const provider = { async send(messages) { batches.push(messages); throw new Error('Provider included ExpoPushToken[secret]') }, async receipts() { return {} } }
  await drain(f.db, provider)
  const waiting = await f.jobs()
  assert.ok(waiting.every(job => job.state === 'queued' && job.last_error_code === 'ProviderUnavailable' && job.attempts === 1))
  await drain(f.db, provider)
  assert.equal(batches.length, 1, 'a second process respects persisted backoff')
  await f.db.query("update native_notification_deliveries set next_attempt_at=now()-interval '1 second'")
  provider.send = async messages => { batches.push(messages); return messages.map(() => ({ status: 'error', code: 'DeviceNotRegistered' })) }
  await drain(f.db, provider)
  assert.deepEqual(batches[1].map(message => message.collapseId).sort(), batches[0].map(message => message.collapseId).sort())
  assert.ok((await f.jobs()).every(job => job.state === 'failed' && job.last_error_code === 'DeviceNotRegistered'))
  assert.equal((await f.db.query("select count(*)::int n from native_notification_devices where user_id in ('child','supervisor') and expo_push_token is not null")).rows[0].n, 0)
  assert.equal((await f.db.query("select expo_push_token from native_notification_devices where device_id=$1", [f.devices.tablet])).rows[0].expo_push_token, 'ExpoPushToken[tablet]', 'failure affects the specific token, not the account’s other device')
  await drain(f.db, provider)
  assert.equal(batches.length, 2)
})

test('a sender finishing after its lease was reclaimed cannot change the new attempt or revoke its token', { skip: !url }, async t => {
  const f = await fixture(t)
  await f.onlyAvailability()
  let reclaimed
  const provider = { async receipts() { return {} }, async send() {
    await f.db.query("update native_notification_deliveries set lease_until=now()-interval '1 second' where state='sending'")
    reclaimed = await claim(f.db)
    return reclaimed.map(() => ({ status: 'error', code: 'DeviceNotRegistered' }))
  } }
  await drain(f.db, provider)
  for (const job of await f.jobs()) {
    assert.equal(job.state, 'sending')
    assert.equal(job.lease_id, reclaimed.find(row => row.id === job.id).leaseId)
    assert.equal(job.attempts, 2)
  }
  assert.equal((await f.db.query("select count(*)::int n from native_notification_devices where user_id in ('child','supervisor') and expo_push_token is not null")).rows[0].n, 2)
})

test('old send failures and receipts cannot disable a newer sign-in even when its Expo token is unchanged', { skip: !url }, async t => {
  for (const stage of ['send', 'receipt']) await t.test(stage, async sub => {
    const f = await fixture(sub); await f.onlyAvailability()
    let release, started
    const waiting = new Promise(resolve => { started = resolve })
    const tickets = new Map()
    const provider = {
      send: async messages => {
        if (stage === 'send') { started(); await new Promise(resolve => { release = resolve }); return messages.map(() => ({ status: 'error', code: 'DeviceNotRegistered' })) }
        return messages.map(message => { const id = randomUUID(); tickets.set(id, message); return { status: 'ok', id } })
      },
      receipts: async ids => { started(); await new Promise(resolve => { release = resolve }); return Object.fromEntries(ids.map(id => [id, { status: 'error', code: 'DeviceNotRegistered' }])) },
    }
    if (stage === 'receipt') { await drain(f.db, provider); await f.db.query("update native_notification_deliveries set next_attempt_at=now() where state='awaiting_receipt'") }
    const running = drain(f.db, provider)
    await waiting
    await f.db.query("update native_notification_devices set session_id='sess_new_login' where user_id='parent'")
    release(); await running
    assert.equal((await f.db.query("select expo_push_token from native_notification_devices where user_id='parent' and device_id=$1", [f.devices.parent])).rows[0].expo_push_token, 'ExpoPushToken[parent]')
  })
})

test('reopening does not revive the earlier readiness event when the task becomes startable a second time', { skip: !url }, async t => {
  const f = await fixture(t)
  await f.onlyAvailability(); await expand(f.db)
  const oldIds = (await f.jobs()).map(job => job.id)
  await f.db.query("update occurrence_tasks set status='completed' where task_id=$1", [f.task])
  await f.db.query("update occurrence_tasks set status='unlocked' where task_id=$1", [f.task])
  await f.onlyAvailability(); await expand(f.db)
  const claims = await claim(f.db)
  assert.equal(claims.length, 3, 'only the latest readiness transition reaches the three eligible devices')
  assert.ok(claims.every(job => !oldIds.includes(job.id)))
  assert.ok((await f.jobs()).filter(job => oldIds.includes(job.id)).every(job => job.state === 'suppressed'))
})
