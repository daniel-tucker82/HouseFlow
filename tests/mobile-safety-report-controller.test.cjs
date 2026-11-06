/* eslint-disable @typescript-eslint/no-require-imports -- Disk SQLite and interrupted native report delivery. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite'), { buildSync } = require('esbuild'), Module = require('node:module')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const root = path.resolve(__dirname, '..'), loaded = new Module(__filename, module)
loaded._compile(buildSync({ stdin: { contents: ['mobile/src/storage/local-store.ts', 'mobile/src/services/safety-report-controller.ts'].map(file => `export * from ${JSON.stringify(path.join(root, file))}`).join(';'), resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, __filename)
const { LocalStore, SafetyReportController } = loaded.exports
class Database {
  constructor(file) { this.raw = new DatabaseSync(file); this.tail = Promise.resolve(); this.fail = false }
  async execAsync(sql) { this.raw.exec(sql) }
  async runAsync(sql, ...args) { if (this.fail) throw new Error('Disk full'); return this.raw.prepare(sql).run(...args) }
  async getFirstAsync(sql, ...args) { return this.raw.prepare(sql).get(...args) ?? null }
  async getAllAsync(sql, ...args) { return this.raw.prepare(sql).all(...args) }
  withExclusiveTransactionAsync(work) {
    const result = this.tail.then(async () => { this.raw.exec('BEGIN IMMEDIATE'); try { await work(this); this.raw.exec('COMMIT') } catch (e) { this.raw.exec('ROLLBACK'); throw e } })
    this.tail = result.catch(() => undefined); return result
  }
}
async function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-report-')), file = path.join(folder, 'device.db'), received = new Map(), sent = []
  const control = { loseReply: false, wrongAccount: false, allowed: true, accountId: 'user_parent', rejectStatus: null }
  let db, store, controller
  const api = { safetyReportingAvailable: async () => true, sendSafetyReport: async draft => {
    sent.push(structuredClone(draft))
    if (control.rejectStatus) throw Object.assign(new Error('Household access ended. Your draft is kept.'), { status: control.rejectStatus })
    if (!received.has(draft.id)) received.set(draft.id, { accountId: control.accountId, householdId: draft.householdId, id: draft.id, receivedAt: new Date().toISOString() })
    if (control.loseReply) throw new Error('Lost server acknowledgement')
    return { ...received.get(draft.id), ...(control.wrongAccount ? { accountId: 'user_someone_else' } : {}) }
  } }
  async function restart() {
    controller?.stop(); await db?.tail; db?.raw.close()
    db = new Database(file); store = new LocalStore(db); await store.initialize()
    controller = new SafetyReportController(store, control.accountId, api, randomUUID, () => control.allowed)
    await controller.start()
  }
  await restart()
  t.after(async () => { controller.stop(); await db.tail; db.raw.close(); assert.equal(path.dirname(folder), os.tmpdir()); assert.match(path.basename(folder), /^cyntch-report-/); fs.rmSync(folder, { recursive: true, force: true }) })
  return { control, received, sent, restart, get db() { return db }, get store() { return store }, get c() { return controller } }
}
async function draft(f) { await f.c.begin(randomUUID()); await f.c.edit({ subject: 'Fixture content', message: 'A concern about this fixture content.' }) }
async function idle(c) { for (let i = 0; i < 100; i++) { if (!c.getSnapshot().sending && !c.getSnapshot().saving) return; await new Promise(resolve => setTimeout(resolve, 2)) } assert.fail('Controller did not settle') }

test('offline drafts and frozen submissions survive SQLite restart, retry the same ID and erase text only after receipt', async t => {
  const f = await fixture(t); await draft(f)
  const original = structuredClone(f.c.getSnapshot().draft)
  await f.restart(); assert.deepEqual(f.c.getSnapshot().draft, original)
  await f.c.submit(); assert.equal(f.sent.length, 0)
  f.control.loseReply = true; f.c.setConnectivity(true); await idle(f.c)
  assert.equal(f.received.size, 1); assert.ok(f.c.getSnapshot().draft)
  await assert.rejects(f.c.edit({ message: 'Changed during pending delivery.' }))
  await assert.rejects(f.c.discard())
  await f.restart(); f.control.loseReply = false; f.c.setConnectivity(true); await idle(f.c)
  assert.equal(f.received.size, 1); assert.deepEqual(f.sent, [original, original])
  assert.equal(f.c.getSnapshot().draft, null); assert.equal(f.c.getSnapshot().receipt.id, original.id)
  const persisted = await f.store.setting('user_parent', 'safety-report-v1')
  assert.equal(persisted.draft, null); assert.equal(JSON.stringify(persisted).includes(original.message), false)
})

test('failed local save prevents any network request, and mismatched confirmation retains the report', async t => {
  const f = await fixture(t); await draft(f); f.db.fail = true
  await assert.rejects(f.c.submit(), /Disk full/)
  f.c.setConnectivity(true); await idle(f.c); assert.equal(f.sent.length, 0)
  f.db.fail = false; f.control.wrongAccount = true; await f.c.flush()
  assert.ok(f.c.getSnapshot().pending); assert.ok(f.c.getSnapshot().draft)
  f.control.wrongAccount = false; await f.c.flush(); assert.equal(f.received.size, 1); assert.equal(f.c.getSnapshot().draft, null)
})

test('queued edits persist in order; account changes and kiosk lock cannot reveal or send another account draft', async t => {
  const f = await fixture(t); await draft(f)
  await Promise.all([f.c.edit({ subject: 'First version' }), f.c.edit({ subject: 'Last version' })])
  await f.restart(); assert.equal(f.c.getSnapshot().draft.subject, 'Last version')
  f.control.allowed = false; await assert.rejects(f.c.submit()); f.c.setConnectivity(true); await idle(f.c); assert.equal(f.sent.length, 0)
  f.control.accountId = 'user_other'; f.control.allowed = true; await f.restart(); assert.equal(f.c.getSnapshot().draft, null)
  f.control.accountId = 'user_parent'; await f.restart(); assert.equal(f.c.getSnapshot().draft.subject, 'Last version')
})

test('backgrounding defers delivery and foreground resume sends without any polling timer', async t => {
  const f = await fixture(t); await draft(f); f.c.setActive(false); f.c.setConnectivity(true); await f.c.submit()
  await idle(f.c); assert.equal(f.sent.length, 0)
  f.c.setActive(true); await idle(f.c); assert.equal(f.received.size, 1)
  f.c.setActive(true); f.c.setConnectivity(true); await idle(f.c); assert.equal(f.sent.length, 1)
})

test('a definite household rejection can be discarded without trapping future reports', async t => {
  const f = await fixture(t); await draft(f); f.control.rejectStatus = 403
  await f.c.submit(); f.c.setConnectivity(true); await idle(f.c)
  assert.equal(f.received.size, 0); assert.equal(f.c.getSnapshot().pending, false)
  await f.restart(); assert.equal(f.c.getSnapshot().pending, false); assert.ok(f.c.getSnapshot().draft)
  await f.c.discard(); await f.c.begin(randomUUID()); assert.equal(f.c.getSnapshot().draft.subject, '')
})
