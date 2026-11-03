/* eslint-disable @typescript-eslint/no-require-imports -- Exercise secure-store ordering with controlled failures and process restarts. */
const { test } = require('node:test'), assert = require('node:assert/strict')
const { randomUUID, randomBytes, createHash } = require('node:crypto')
const path = require('node:path'), Module = require('node:module'), { buildSync } = require('esbuild')
const filename = path.resolve(__dirname, '../mobile/src/storage/kiosk-pin-vault.ts'), loaded = new Module(filename, module)
loaded._compile(buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, filename)
const { KioskPinVault } = loaded.exports

function fixture() {
  const saved = new Map(), id = randomUUID(), pin = '810426'
  let elapsed = 0, writes = 0, failWrite = 0, hashes = 0, failDigest = false
  const storage = { get: async key => saved.get(key) ?? null, set: async (key, value) => { if (++writes === failWrite) throw new Error('Secure storage unavailable'); saved.set(key, value) }, remove: async key => saved.delete(key) }
  const crypto = { randomSecret: async () => randomBytes(32).toString('hex'), digest: async value => {
    hashes++; if (failDigest) throw new Error('Interrupted verification'); return createHash('sha256').update(value).digest('hex')
  } }
  let vault = new KioskPinVault(storage, crypto, () => elapsed)
  return { id, pin, saved, storage, crypto, get vault() { return vault }, get hashes() { return hashes },
    record: () => JSON.parse(saved.get(`cyntch.kiosk-pin.${id}`)),
    failNextWrite: () => { failWrite = writes + 1 }, failWriteAfter: count => { failWrite = writes + count },
    interruptDigest: value => { failDigest = value }, advance: value => { elapsed += value },
    restart: () => { elapsed = 0; vault = new KioskPinVault(storage, crypto, () => elapsed) } }
}
test('K04 PINs stay out of persistent records and correct verification returns the original activation capability', async () => {
  const f = fixture(), exitSecret = await f.vault.create(f.id, f.pin)
  assert.match(exitSecret, /^[a-f0-9]{64}$/)
  assert.notEqual(f.record().pepper, exitSecret)
  assert.ok(!Object.keys(f.record()).includes('pin'))
  assert.equal(f.record().verifier, createHash('sha256').update(`cyntch:kiosk-pin:v1:${f.id}:${f.record().pepper}:${f.pin}`).digest('hex'))
  assert.equal(await f.vault.activationKey(f.id), exitSecret)
  assert.deepEqual(await f.vault.verify(f.id, '123456'), { matched: false, retryAfterMs: 0 })
  f.restart()
  assert.deepEqual(await f.vault.verify(f.id, f.pin), { matched: true, exitSecret })
  assert.equal(f.record().attempts, 0)
  await assert.rejects(f.vault.create(f.id, '000000'), /already configured/)
  await f.vault.remove(f.id)
  await assert.rejects(f.vault.verify(f.id, f.pin), /recover access/)
})
test('K04 failed attempts and increasing cooldown survive restart without consulting the wall clock', async () => {
  const f = fixture(); await f.vault.create(f.id, f.pin)
  for (let i = 0; i < 5; i++) { await f.vault.verify(f.id, '000000'); f.restart() }
  assert.equal(f.record().attempts, 5)
  assert.equal(await f.vault.waitRemaining(f.id), 30_000)
  const hashes = f.hashes
  await assert.rejects(f.vault.verify(f.id, f.pin), error => error.retryAfterMs === 30_000)
  assert.equal(f.hashes, hashes)
  f.advance(29_999); assert.equal(await f.vault.waitRemaining(f.id), 1)
  f.restart(); assert.equal(await f.vault.waitRemaining(f.id), 30_000, 'relaunch cannot skip a cooldown')
  f.advance(30_000)
  assert.deepEqual(await f.vault.verify(f.id, '000000'), { matched: false, retryAfterMs: 60_000 })
  f.advance(60_000)
  assert.equal((await f.vault.verify(f.id, f.pin)).matched, true)
  for (let i = 0; i < 5; i++) await f.vault.verify(f.id, '000000')
  assert.equal(await f.vault.waitRemaining(f.id), 30_000, 'reset attempt counts cannot reuse an expired deadline')
})
test('K04 a process interruption during verification cannot restore a consumed attempt', async () => {
  const f = fixture(); await f.vault.create(f.id, f.pin)
  for (let i = 0; i < 4; i++) await f.vault.verify(f.id, '000000')
  f.interruptDigest(true)
  await assert.rejects(f.vault.verify(f.id, f.pin), /Interrupted verification/)
  assert.equal(f.record().attempts, 5)
  f.restart(); f.interruptDigest(false)
  await assert.rejects(f.vault.verify(f.id, f.pin), error => error.retryAfterMs === 30_000)
})
test('K04 failed secure writes never release an unlock capability or allow unreserved guesses', async () => {
  const f = fixture(); f.failNextWrite()
  await assert.rejects(f.vault.create(f.id, f.pin), /Secure storage unavailable/)
  assert.equal(f.saved.size, 0)
  await f.vault.create(f.id, f.pin)
  const hashes = f.hashes; f.failNextWrite()
  await assert.rejects(f.vault.verify(f.id, f.pin), /Secure storage unavailable/)
  assert.equal(f.hashes, hashes, 'do not check a PIN until the attempt is durable')
  f.failWriteAfter(2)
  await assert.rejects(f.vault.verify(f.id, f.pin), /Secure storage unavailable/)
  assert.equal(f.record().attempts, 1)
  assert.equal((await f.vault.verify(f.id, f.pin)).matched, true)
})
test('K04 concurrent PIN checks serialize across vault instances and another device lock has its own verifier', async () => {
  const f = fixture(); await f.vault.create(f.id, f.pin)
  const other = new KioskPinVault(f.storage, f.crypto, () => 0), second = randomUUID()
  await other.create(second, f.pin)
  assert.notEqual(JSON.parse(f.saved.get(`cyntch.kiosk-pin.${second}`)).verifier, f.record().verifier)
  const results = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => (i % 2 ? other : f.vault).verify(f.id, '000000')))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 5)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.retryAfterMs === 30_000).length, 4)
  assert.equal(f.record().attempts, 5)
  assert.equal((await other.verify(second, f.pin)).matched, true)
})
test('K04 missing, malformed or unsupported secure data always requires recovery', async () => {
  const f = fixture()
  for (const pin of ['', '12345', '1234567', 'abcdef']) await assert.rejects(f.vault.create(f.id, pin), /six-digit/)
  await assert.rejects(f.vault.create('../bad-id', f.pin), /recover access/)
  await f.vault.create(f.id, f.pin)
  const original = f.record(), key = `cyntch.kiosk-pin.${f.id}`
  for (const value of ['not JSON', '{}', JSON.stringify({ ...original, format: 2 }), JSON.stringify({ ...original, attempts: 6, cooldownMs: 0 }), JSON.stringify({ ...original, exitSecret: '' })]) {
    f.saved.set(key, value)
    await assert.rejects(f.vault.verify(f.id, f.pin), /recover access/)
    await assert.rejects(f.vault.activationKey(f.id), /recover access/)
  }
})
