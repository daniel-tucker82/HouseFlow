/* eslint-disable @typescript-eslint/no-require-imports -- Real isolated PostgreSQL integration tests. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { buildSync } = require('esbuild')
const { Pool } = require('pg')

const filename = path.resolve(__dirname, '../lib/completion-operations.ts')
const bundled = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = new Module(filename, module)
loaded._compile(bundled.outputFiles[0].text, filename)
const { parseCompletionOperation, findCompletionReceipt, claimCompletionVersion, recordCompletionReceipt } = loaded.exports
const url = process.env.CYNTCH_TEST_DATABASE_URL
const hh = randomUUID(), occurrence = randomUUID(), task = randomUUID(), device = randomUUID(), secondDevice = randomUUID()

test('completion metadata rejects unsafe values and binds receipt hashes to the full change', () => {
  const body = { householdId: hh, occurrenceId: occurrence, taskId: task, completed: true,
    clientOperation: { id: randomUUID(), deviceId: device, sequence: 1, correctedTimeMs: 1000 } }
  const parsed = parseCompletionOperation(body, 'parent', 2000)
  assert.equal(parsed.version.correctedTimeMs, 1000)
  assert.notEqual(parsed.requestHash, parseCompletionOperation({ ...body, completed: false }, 'parent', 2000).requestHash)
  assert.equal(parseCompletionOperation(body, 'parent', 500).version.correctedTimeMs, 500)
  for (const field of [{ sequence: -1 }, { sequence: 1.1 }, { correctedTimeMs: NaN }, { id: 'bad' }, { deviceId: null }]) {
    assert.throws(() => parseCompletionOperation({ ...body, clientOperation: { ...body.clientOperation, ...field } }, 'parent'))
  }
})

test('C03 O05 PostgreSQL serializes conflicts, preserves stream order, and atomically records receipts', { skip: !url }, async t => {
  const target = new URL(url)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test', 'Only the isolated local test database may be used')
  const pool = new Pool({ connectionString: url, max: 4 })
  const schema = `mobile_test_${randomUUID().replaceAll('-', '')}`
  const setup = await pool.connect()
  await setup.query(`create schema ${schema}`)
  await setup.query(`set search_path to ${schema}`)
  await setup.query(`create table users(id text primary key); create table households(id uuid primary key);
    create table routine_occurrences(id uuid primary key); create table tasks(id uuid primary key);
    create table occurrence_tasks(occurrence_id uuid, task_id uuid, status text, primary key(occurrence_id, task_id));`)
  const migration = readFileSync(path.resolve(__dirname, '../database/0018_completion_operations.sql'), 'utf8')
  await setup.query(migration)
  await setup.query(migration)
  await setup.query("insert into users values ('parent')")
  await setup.query('insert into households values ($1)', [hh])
  await setup.query('insert into routine_occurrences values ($1)', [occurrence])
  await setup.query('insert into tasks values ($1)', [task])
  await setup.query("insert into occurrence_tasks values ($1,$2,'unlocked')", [occurrence, task])
  setup.release()
  t.after(async () => { await pool.query(`drop schema ${schema} cascade`); await pool.end() })

  function body(sequence, time, completed = true, deviceId = device) {
    return { householdId: hh, occurrenceId: occurrence, taskId: task, completed,
      clientOperation: { id: randomUUID(), deviceId, sequence, correctedTimeMs: time } }
  }
  async function apply(input, failBeforeCommit = false) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(`set local search_path to ${schema}`)
      const op = parseCompletionOperation(input, 'parent', 100_000)
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`completion:parent:${op.version.operationId}`])
      const receipt = await findCompletionReceipt(client, 'parent', op)
      if (receipt) { await client.query('commit'); return receipt }
      await client.query('select id from routine_occurrences where id=$1 for update', [occurrence])
      const wins = await claimCompletionVersion(client, occurrence, task, op)
      if (wins) await client.query('update occurrence_tasks set status=$1 where occurrence_id=$2 and task_id=$3', [input.completed ? 'completed' : 'unlocked', occurrence, task])
      const statuses = await client.query('select task_id,status from occurrence_tasks where occurrence_id=$1', [occurrence])
      const result = { operationId: op.version.operationId, outcome: wins ? 'applied' : 'superseded', occurrenceTaskStatuses: statuses.rows }
      await recordCompletionReceipt(client, 'parent', hh, op, result)
      if (failBeforeCommit) throw new Error('Simulated interruption')
      await client.query('commit')
      return result
    } catch (error) { await client.query('rollback'); throw error }
    finally { client.release() }
  }

  const first = body(1, 1000)
  const concurrent = await Promise.all([apply(first), apply(first)])
  assert.deepEqual(concurrent[0], concurrent[1], 'lost acknowledgement produces the same result without applying twice')
  await assert.rejects(apply({ ...first, completed: false }), /already used/)
  assert.equal((await apply(body(1, 2000, false, secondDevice))).outcome, 'applied')
  assert.equal((await apply(body(2, 1500))).outcome, 'superseded', 'older offline completion loses to a newer other-device edit')
  assert.equal((await apply(body(1, 9000))).outcome, 'superseded', 'old same-device sequence cannot be revived by an incorrect high clock')
  assert.equal((await apply(body(3, 3000))).outcome, 'applied')
  assert.equal((await apply(body(4, 500, false))).outcome, 'applied', 'newer same-device edit remains newer after its clock moves backwards')
  const interrupted = body(5, 4000)
  await assert.rejects(apply(interrupted, true), /Simulated interruption/)
  assert.equal((await apply(interrupted)).outcome, 'applied', 'rolled-back version and receipt remain retryable')
  const older = body(6, 4500, false), newer = body(2, 5000, true, secondDevice)
  await Promise.all([apply(older), apply(newer)])
  const inspect = await pool.query(`select status from ${schema}.occurrence_tasks`)
  assert.equal(inspect.rows[0].status, 'completed', 'the newest cross-device estimate wins regardless of lock acquisition order')
  assert.equal((await pool.query(`select count(*)::int as count from ${schema}.completion_operations where operation_id=$1`, [first.clientOperation.id])).rows[0].count, 1)
})
