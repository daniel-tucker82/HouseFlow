/* eslint-disable @typescript-eslint/no-require-imports -- Exercise native lifecycle races without a simulator. */
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path'), Module = require('node:module'), { buildSync } = require('esbuild')
const loaded = new Module(__filename, module)
loaded._compile(buildSync({ stdin: { contents: 'export * from "./mobile/src/services/invitation-controller"; export * from "./mobile/src/services/api";', resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, __filename)
const { InvitationController, MobileApi } = loaded.exports
const item = { id: 'invite-1', code: 'invite', maxUses: 10, usesCount: 0, expiresAt: '2027-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', status: 'available' }
const page = (items = [item], nextCursor = null) => ({ accountId: 'owner', householdId: 'home', items, nextCursor })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const settle = () => new Promise(resolve => setImmediate(resolve))

test('hidden/offline invitation reads and mutations cannot restore links; reconnect reloads once', async () => {
  const old = deferred(), next = deferred(); let reads = 0, writes = 0
  const c = new InvitationController({ invitations: () => (++reads === 1 ? old.promise : next.promise), request: async () => { writes++ } }, 'home')
  c.setEnabled(true); c.setEnabled(false); old.resolve(page()); await settle()
  assert.equal(c.snapshot().page, null)
  await c.create(10, 30); await c.revoke(item.id); assert.equal(writes, 0)
  c.setEnabled(true); next.resolve(page()); await settle()
  assert.equal(reads, 2); assert.equal(c.snapshot().ready, true)
  c.setEnabled(false); assert.equal(c.snapshot().page, null)
})

test('lost create response refreshes the list and never repeats the mutation; repeated taps are fenced', async () => {
  const save = deferred(); let reads = 0, writes = 0
  const c = new InvitationController({ invitations: async () => page(++reads === 1 ? [] : [item]), request: async () => { writes++; return save.promise } }, 'home')
  c.setEnabled(true); await settle()
  const pending = c.create(10, 30); await c.create(10, 30)
  save.reject(new Error('Connection interrupted')); await pending
  assert.equal(writes, 1); assert.equal(reads, 2); assert.equal(c.snapshot().page.items.length, 1)
  assert.match(c.snapshot().error, /Check the refreshed invitation list/)
  assert.equal(c.snapshot().ready, true)
})

test('revocation confirmation after blur is ignored and access failures clear older links', async () => {
  let reads = 0, writes = 0
  const c = new InvitationController({ invitations: async () => { if (++reads > 1) throw new Error('Owner access removed'); return page() }, request: async () => { writes++ } }, 'home')
  c.setEnabled(true); await settle(); c.setEnabled(false)
  await c.revoke(item.id); assert.equal(writes, 0)
  c.setEnabled(true); await settle()
  assert.equal(c.snapshot().page, null); assert.equal(c.snapshot().ready, false)
  await c.create(10, 30); assert.equal(writes, 0)
})

test('a mutation finishing across blur/refocus refreshes without reviving old success messages', async () => {
  const save = deferred(); let reads = 0, writes = 0
  const c = new InvitationController({ invitations: async () => { reads++; return page() }, request: () => { writes++; return save.promise } }, 'home')
  c.setEnabled(true); await settle()
  const pending = c.revoke(item.id)
  c.setEnabled(false); c.setEnabled(true)
  await c.create(10, 30); assert.equal(writes, 1); assert.equal(reads, 1)
  save.resolve({}); await pending
  assert.equal(reads, 2); assert.equal(c.snapshot().message, null); assert.equal(c.snapshot().ready, true)
})

test('invitation transport rejects another account or household response', async t => {
  const oldFetch = global.fetch
  t.after(() => { global.fetch = oldFetch })
  const api = new MobileApi('https://fixture.cyntch.test', 'owner', 'device', async () => 'fixture')
  for (const wrong of [{ accountId: 'another' }, { householdId: 'another' }]) {
    global.fetch = async () => Response.json({ ...page(), ...wrong })
    await assert.rejects(api.invitations('home'), /household changed/)
  }
})
