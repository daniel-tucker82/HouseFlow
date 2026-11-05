/* eslint-disable @typescript-eslint/no-require-imports -- Verify real LISTEN connections and disconnects. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { Pool } = require('pg')
const { fixture, connectionString } = require('./helpers/account-deletion.cjs')

test('a locked display watches only its household, never sends board data, and loses access on revocation', { skip: !connectionString, timeout: 15_000 }, async t => {
  const f = await fixture(t)
  const oldFlag = process.env.CYNTCH_BOARD_EVENTS_ENABLED
  const oldDirect = process.env.CYNTCH_BOARD_LISTEN_URL
  t.after(() => { if (oldDirect === undefined) delete process.env.CYNTCH_BOARD_LISTEN_URL; else process.env.CYNTCH_BOARD_LISTEN_URL = oldDirect })
  t.after(() => { if (oldFlag === undefined) delete process.env.CYNTCH_BOARD_EVENTS_ENABLED; else process.env.CYNTCH_BOARD_EVENTS_ENABLED = oldFlag })
  f.identity.sessionClaims = { exp: Math.floor(Date.now() / 1000) + 120 }
  const route = f.load(['app/api/mobile/board-events/route.ts'])
  const stop = new AbortController()
  const request = (id, extra = {}) => new Request('https://fixture.cyntch.test/api/mobile/board-events?householdId=' + id, {
    signal: stop.signal, headers: { 'X-Task-Save-User': f.owner, 'X-Cyntch-Session': f.scope.sessionId, 'X-Cyntch-Device': f.scope.deviceId, ...extra },
  })
  let reader
  try {
    delete process.env.CYNTCH_BOARD_EVENTS_ENABLED
    assert.equal((await route.GET(request(f.transfer))).status, 404)
    process.env.CYNTCH_BOARD_EVENTS_ENABLED = 'true'
    for (const invalid of ['', 'https://invalid.test', 'postgresql://ep-example-pooler.invalid.test/db', connectionString+'?pgbouncer=true']) {
      process.env.CYNTCH_BOARD_LISTEN_URL = invalid
      assert.equal((await route.GET(request(f.transfer))).status, 404, 'do not offer a listener on missing or transaction-pooled settings')
    }
    process.env.CYNTCH_BOARD_LISTEN_URL = connectionString
    assert.equal((await route.GET(request(f.transfer, { 'X-Cyntch-Session': 'different' }))).status, 403)
    assert.equal((await route.GET(request(randomUUID()))).status, 403)
    await f.db.query('alter table occurrence_tasks disable trigger board_occurrence_status_changed')
    assert.equal((await route.GET(request(f.transfer))).status, 503, 'enabling the flag before the signal is installed cannot advertise a ready stream')
    await f.db.query('alter table occurrence_tasks enable trigger board_occurrence_status_changed')
    await f.db.query(`insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash)
      values($1,$2,$3,$4,$5,array[$2],array[$2],repeat('a',64),repeat('b',64))`, [randomUUID(), f.owner, f.scope.sessionId, f.scope.deviceId, f.transfer])
    assert.equal((await route.GET(request(f.deleting))).status, 423, 'kiosk cannot watch a second household its parent manages')
    const response = await route.GET(request(f.transfer))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control'), /no-store/)
    reader = response.body.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'ready\n')
    assert.equal((await f.db.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) ok', [f.lib.kioskSessionKey(f.scope.sessionId)])).rows[0].ok, true, 'idle watch does not hold the session gate')
    const hint = () => f.db.query("select pg_notify('cyntch_board_'||md5(current_schema()||':'||$1::text),'')", [f.transfer])
    await hint()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'changed\n')
    await f.db.query("update household_members set role='member' where household_id=$1 and user_id=$2", [f.transfer, f.owner])
    await hint()
    assert.equal((await reader.read()).done, true, 'a former parent cannot observe subsequent activity through the old stream')
    assert.equal((await route.GET(request(f.transfer))).status, 423)
  } finally { stop.abort(); await reader?.cancel() }
})

test('foreground boards share one PostgreSQL listener, release it on exit and recover its loss', { skip: !connectionString, timeout: 20_000 }, async t => {
  const f = await fixture(t), { BoardSignalHub } = f.load(['lib/board-signal-hub.ts'])
  const marker = 'cyntch_board_test_' + randomUUID()
  const pool = new Pool({ connectionString, application_name: marker, max: 1, connectionTimeoutMillis: 1_500 })
  const hub = new BoardSignalHub(pool, f.db, 3), controllers = [], alerts = []
  const [first, second] = await Promise.all([f.transfer, f.shared].map(async id =>
    (await f.db.query("select 'cyntch_board_'||md5(current_schema()||':'||$1::text) channel", [id])).rows[0].channel))
  const session = async (channel, name) => {
    const controller = new AbortController()
    controllers.push(controller)
    const close = await hub.subscribe(channel, controller.signal, {
      changed: () => alerts.push(name), disconnected: () => alerts.push(name + ':lost'),
    })
    return { controller, close }
  }
  const until = async check => {
    const start = performance.now()
    while (!check() && performance.now() - start < 2_000) await new Promise(r => setTimeout(r, 10))
    assert.ok(check(), 'expected event or resource release did not occur')
  }
  const notify = channel => f.db.query("select pg_notify($1,'')", [channel])
  try {
    // A valid PostgreSQL session connected to the wrong database can accept
    // LISTEN but cannot receive the application's committed probe.
    const unrelated = new Pool({ connectionString: new URL('/postgres', connectionString).href, max: 1 })
    try {
      const wrong = new BoardSignalHub(pool, unrelated)
      await assert.rejects(wrong.subscribe(first, new AbortController().signal, { changed() {}, disconnected() {} }), /probe timed out/)
      await until(() => pool.totalCount === 0)
    } finally { await unrelated.end() }
    const [phone, tablet, neighbour] = await Promise.all([session(first, 'phone'), session(first, 'tablet'), session(second, 'neighbour')])
    assert.equal(pool.totalCount, 1)
    await assert.rejects(session(first, 'extra'), /capacity/)
    await assert.rejects(session('public;UNLISTEN *', 'bad'), /Invalid/)
    await notify(first); await notify(second)
    await until(() => alerts.length === 3)
    assert.deepEqual(alerts.splice(0), ['phone', 'tablet', 'neighbour'])
    phone.controller.abort(); phone.close()
    await notify(first); await until(() => alerts.length === 1)
    assert.deepEqual(alerts.splice(0), ['tablet'])
    // Terminate only the connection uniquely tagged by this test on the
    // disposable database. Another subscriber on the same hub must also learn
    // it needs to reconnect and take a fresh authorized snapshot.
    const killed = await f.db.query("select pg_terminate_backend(pid) ok from pg_stat_activity where datname=current_database() and application_name=$1", [marker])
    assert.deepEqual(killed.rows, [{ ok: true }])
    await until(() => alerts.length === 2)
    assert.deepEqual(alerts.splice(0).sort(), ['neighbour:lost', 'tablet:lost'])
    tablet.close(); neighbour.close()
    const newPhone = await session(first, 'reconnected')
    await notify(first); await until(() => alerts.length === 1)
    assert.deepEqual(alerts, ['reconnected'])
    newPhone.close(); await until(() => pool.totalCount === 0)
  } finally {
    for (const c of controllers) c.abort()
    await pool.end()
  }
})
