/* eslint-disable @typescript-eslint/no-require-imports -- Isolated PostgreSQL regression. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { transformSync } = require('esbuild')
const filename = path.resolve(__dirname, '../lib/task-edit-version.ts')
const loaded = new Module(filename, module)
loaded._compile(transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs' }).code, filename)
const { claimTaskEditVersion, validTaskEditVersion } = loaded.exports
const taskId = 'b98ce792-81b7-4ceb-bbb2-1a17c8134901'
const stream = '41147524-744a-4565-9e9c-f1e3966596d7'
const saveId = 'b98ce792-81b7-4ceb-bbb2-1a17c8134902'
const edit = { taskId, saveStreamId: stream, saveId, saveRevision: 10 }

test('save versions reject incomplete, malformed and unsafe values', () => {
  assert.equal(validTaskEditVersion({}), true)
  assert.equal(validTaskEditVersion(edit), true)
  for (const body of [{ saveId }, { ...edit, saveRevision: NaN }, { ...edit, saveRevision: -1 }, { ...edit, saveRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...edit, saveStreamId: 'invalid' }]) {
    assert.equal(validTaskEditVersion(body), false)
  }
})

test('PostgreSQL rejects late/duplicate saves and rolls back version claims with failed writes', { skip: !process.env.CYNTCH_PGLITE_PATH && !process.env.CYNTCH_TEST_DATABASE_URL }, async () => {
  let database
  if (process.env.CYNTCH_TEST_DATABASE_URL) {
    const target = new URL(process.env.CYNTCH_TEST_DATABASE_URL)
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && target.pathname === '/cyntch_mobile_test')
    const { Pool } = require('pg'), { randomUUID } = require('node:crypto')
    const pool = new Pool({ connectionString: target.toString() }), connection = await pool.connect()
    const schema = `task_version_${randomUUID().replaceAll('-', '')}`
    await connection.query(`create schema ${schema}`)
    await connection.query(`set search_path to ${schema}`)
    database = { exec: sql => connection.query(sql), query: (sql, values) => connection.query(sql, values), close: async () => {
      try { await connection.query('rollback'); await connection.query('set search_path to public'); await connection.query(`drop schema ${schema} cascade`) }
      finally { connection.release(); await pool.end() }
    } }
  } else {
    const { PGlite } = require(process.env.CYNTCH_PGLITE_PATH)
    database = new PGlite()
  }
  const client = { query: async (sql, values) => { const result = await database.query(sql, values); return { ...result, rowCount: result.rows.length } } }
  try {
    await database.exec('create table users (id text primary key); create table tasks (id uuid primary key, title text);')
    const migration = fs.readFileSync(path.resolve(__dirname, '../database/0017_task_edit_versions.sql'), 'utf8')
    await database.exec(migration)
    await database.exec(migration)
    await database.query("insert into users values ('user-a')")
    await database.query("insert into tasks values ($1, 'Original')", [taskId])
    assert.equal(await claimTaskEditVersion(client, 'user-a', edit), true)
    assert.equal(await claimTaskEditVersion(client, 'user-a', edit), false, 'a retry must not replay relative time rules')
    assert.equal(await claimTaskEditVersion(client, 'user-a', { ...edit, saveRevision: 9 }), false)
    assert.equal(await claimTaskEditVersion(client, 'user-a', { ...edit, saveRevision: 11 }), true)
    assert.equal(await claimTaskEditVersion(client, 'user-a', edit), false, 'a late request after navigation cannot overwrite the newer edit')
    await database.exec('begin')
    assert.equal(await claimTaskEditVersion(client, 'user-a', { ...edit, saveRevision: 12 }), true)
    await database.exec('rollback')
    assert.equal(await claimTaskEditVersion(client, 'user-a', { ...edit, saveRevision: 12 }), true, 'a failed transaction remains retryable')
    assert.equal(await claimTaskEditVersion(client, 'user-a', { ...edit, saveStreamId: saveId }), true, 'another browser has its own stream')
    await database.query('delete from tasks where id=$1', [taskId])
    assert.equal((await database.query('select * from task_edit_versions')).rows.length, 0)
  } finally { await database.close() }
})
