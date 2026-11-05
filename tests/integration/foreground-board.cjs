/* eslint-disable @typescript-eslint/no-require-imports -- Loopback HTTP, PostgreSQL and real client SQLite. */
const { test } = require('node:test'), assert = require('node:assert/strict')
const { createServer } = require('node:http'), { Readable } = require('node:stream')
const { randomUUID } = require('node:crypto')
const { fixture, connectionString } = require('../helpers/account-deletion.cjs')
const { SqliteAdapter } = require('../helpers/mobile-sqlite.cjs')

test('a quiet foreground client learns committed peer task states, suspends and catches up using the same board API', { skip: !connectionString, timeout: 35_000 }, async t => {
  const f = await fixture(t), run = randomUUID(), task = randomUUID(), remaining = randomUUID()
  f.identity.sessionClaims = { exp: Math.floor(Date.now()/1000) + 120 }
  const oldFlag = process.env.CYNTCH_BOARD_EVENTS_ENABLED
  process.env.CYNTCH_BOARD_EVENTS_ENABLED = 'true'
  t.after(() => { if (oldFlag === undefined) delete process.env.CYNTCH_BOARD_EVENTS_ENABLED; else process.env.CYNTCH_BOARD_EVENTS_ENABLED = oldFlag })
  await f.db.query("insert into routine_occurrences(id,household_id,kind,title,scheduled_for) values($1,$2,'manual','Weekly tasks',now())", [run,f.transfer])
  for (const id of [task, remaining]) {
    await f.db.query("insert into tasks(id,household_id,routine_occurrence_id,title) values($1,$2,$3,'Board fixture')", [id,f.transfer,run])
    await f.db.query("insert into occurrence_tasks(occurrence_id,task_id,status) values($1,$2,'unlocked')", [run,id])
  }
  const bootstrap = f.load(['app/api/mobile/bootstrap/route.ts'], {
    'next/navigation': { redirect: () => assert.fail('unexpected redirect') },
    '@/lib/push': { dispatchPushForNotificationIds: async () => {} },
    '@/lib/user-sync': { ensureCurrentUserRecord: async () => {} },
  }).GET
  const watch = f.load(['app/api/mobile/board-events/route.ts']).GET
  let bootstraps = 0, watches = 0, clocks = 0, openStreams = 0
  const server = createServer(async (req, res) => {
    const stop = new AbortController()
    res.once('close', () => stop.abort())
    try {
      const request = new Request('https://fixture.cyntch.test' + req.url, { headers: req.headers, signal: stop.signal })
      let response
      if (req.headers.authorization !== 'Bearer fixture') response = new Response(null, { status: 401 })
      else if (req.url.startsWith('/api/mobile/bootstrap?')) { bootstraps++; response = await bootstrap(request) }
      else if (req.url.startsWith('/api/mobile/board-events?')) { watches++; response = await watch(request); openStreams++; res.once('close', () => { openStreams-- }) }
      else { if (req.url === '/api/mobile/time') clocks++; response = new Response(null, { status: 404 }) }
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res)
      else res.end()
    } catch { if (!res.headersSent) res.writeHead(500); res.end() }
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const originalFetch = global.fetch
  global.fetch = (address, init) => {
    const url = new URL(address)
    assert.equal(url.origin, 'https://fixture.cyntch.test')
    return originalFetch('http://127.0.0.1:' + server.address().port + url.pathname + url.search, init)
  }
  const localDb = new SqliteAdapter(':memory:')
  const { LocalStore, MobileApi, BoardController } = f.load(['mobile/src/storage/local-store.ts','mobile/src/services/api.ts','mobile/src/services/board-controller.ts'])
  const local = new LocalStore(localDb)
  const api = new MobileApi('https://fixture.cyntch.test', f.owner, f.scope.deviceId, async () => 'fixture', async () => f.secret, f.scope.sessionId)
  const board = new BoardController(local, f.owner, f.scope.deviceId, api, randomUUID, (id, signal, hint) => api.watchBoard(id,signal,hint,global.fetch))
  const state = () => board.getSnapshot().board?.tasks.find(item => item.id === task)?.status
  const until = async predicate => {
    const start = performance.now()
    while (!predicate() && performance.now()-start < 4_000) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(predicate(), 'active client did not converge within four seconds: ' + (board.getSnapshot().error ?? 'no reported error'))
  }
  const write = status => f.db.query('update occurrence_tasks set status=$1 where occurrence_id=$2 and task_id=$3', [status,run,task])
  try {
    await local.initialize()
    await local.cacheBoard(f.owner,(await api.bootstrap(f.transfer)).board)
    await local.saveSetting(f.owner,'selected-household',f.transfer)
    await board.start(); board.setConnectivity(true); board.setBoardVisible(true)
    await until(() => watches === 1 && bootstraps >= 3 && state() === 'unlocked')
    const lags = []
    for (let i = 0; i < 20; i++) {
      const desired = i % 2 ? 'unlocked' : 'completed'
      await write(desired); const committed = performance.now()
      await until(() => state() === desired)
      lags.push(performance.now()-committed)
    }
    lags.sort((a,b)=>a-b)
    t.diagnostic(`20 committed peer changes → receiver board state over loopback HTTP and SQLite, median ${lags[9].toFixed(1)} ms, p95 ${lags[18].toFixed(1)} ms, max ${lags[19].toFixed(1)} ms. Excludes OS rendering, production network and provider authentication.`)
    assert.ok(lags[18] < 5_000)
    await f.db.query("update tasks set title='Remember the lunchbox' where id=$1", [task])
    await until(() => board.getSnapshot().board?.tasks.some(item => item.id === task && item.title === 'Remember the lunchbox'))
    await f.db.query("update households set name='Our shared display' where id=$1", [f.transfer])
    await until(() => board.getSnapshot().board?.household.name === 'Our shared display')
    board.setActive(false); await until(() => openStreams === 0)
    await write('completed')
    assert.equal(state(),'unlocked')
    board.setActive(true); await until(() => state() === 'completed' && watches === 2)
    board.setConnectivity(false); await until(() => openStreams === 0)
    await write('unlocked')
    board.setConnectivity(true); await until(() => state() === 'unlocked' && watches === 3)
    board.setBoardVisible(false); await until(() => openStreams === 0)
    await write('completed')
    assert.equal(state(), 'unlocked')
    board.setBoardVisible(true); await until(() => state() === 'completed' && watches === 4)
    assert.equal(clocks,0, 'a quiet receiver never requests a clock correction')
  } finally {
    board.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    global.fetch = originalFetch
    await localDb.tail
    localDb.database.close()
  }
})
