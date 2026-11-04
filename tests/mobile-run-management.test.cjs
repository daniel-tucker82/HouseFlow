/* eslint-disable @typescript-eslint/no-require-imports -- Native transport through real flow handlers and isolated PostgreSQL. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { fixture, connectionString } = require('./helpers/account-deletion.cjs')

test('native rename/delete preserve the routine and other runs; actual server permissions and kiosk checks apply', { skip: !connectionString }, async t => {
  const f = await fixture(t), after = []
  const next = { NextResponse: { json: (body, init) => Response.json(body, init) }, after: work => after.push(work) }
  const { POST } = f.load(['app/api/leader/flow/route.ts'], { 'next/server': next })
  const { MobileApi } = f.load(['mobile/src/services/api.ts'])
  const routine = (await f.db.query('select id from routines where household_id=$1 limit 1', [f.transfer])).rows[0].id
  const run = randomUUID(), other = randomUUID(), templateTask = randomUUID(), task = randomUUID()
  await f.db.query("insert into routine_occurrences(id,routine_id,household_id,kind,title,scheduled_for,status,created_by) values($1,$3,$4,'routine','Morning',now(),'active',$5),($2,$3,$4,'routine','Other run',now(),'active',$5)", [run, other, routine, f.transfer, f.owner])
  await f.db.query("insert into tasks(id,routine_id,household_id,routine_occurrence_id,title,created_by) values($1,$3,$4,null,'Template task',$6),($2,$3,$4,$5,'Snapshot task',$6)", [templateTask, task, routine, f.transfer, run, f.owner])
  await f.db.query("insert into occurrence_tasks(occurrence_id,task_id,status) values($1,$2,'unlocked')", [run, task])
  const oldFetch = global.fetch
  global.fetch = async (url, init) => {
    assert.equal(new URL(url).origin, 'https://fixture.cyntch.test')
    assert.equal(new Headers(init.headers).get('X-Task-Save-User'), f.owner)
    return POST(new Request(url, init))
  }
  t.after(() => { global.fetch = oldFetch })
  const api = new MobileApi('https://fixture.cyntch.test', f.owner, f.scope.deviceId, async () => 'fixture-token', async () => f.secret, f.scope.sessionId)
  assert.equal(await api.renameRun(f.transfer, run, 'School morning'), 'School morning')
  assert.equal((await f.db.query('select title from routine_occurrences where id=$1', [run])).rows[0].title, 'School morning')
  assert.equal((await f.db.query('select name from routines where id=$1', [routine])).rows[0].name, 'Fixture routine')
  await f.db.query("update household_members set role='member' where household_id=$1 and user_id=$2", [f.transfer, f.owner])
  await assert.rejects(api.renameRun(f.transfer, run, 'Forbidden'), error => error.status === 403)
  await assert.rejects(api.deleteRun(f.transfer, run), error => error.status === 403)
  await f.db.query("update household_members set role='supervisor' where household_id=$1 and user_id=$2", [f.transfer, f.owner])
  await f.db.query("insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array[$2],array[$2],$6,$6)", [randomUUID(), f.owner, f.scope.sessionId, f.scope.deviceId, f.transfer, 'b'.repeat(64)])
  await assert.rejects(api.renameRun(f.transfer, run, 'Locked'), error => error.status === 423)
  await assert.rejects(api.deleteRun(f.transfer, run), error => error.status === 423)
  await f.db.query('delete from native_kiosk_sessions where user_id=$1', [f.owner])
  await assert.rejects(api.deleteRun(f.deleting, run), error => [403, 404].includes(error.status))
  assert.equal((await f.db.query('select title from routine_occurrences where id=$1', [run])).rows[0].title, 'School morning')
  await api.deleteRun(f.transfer, run)
  assert.equal((await f.db.query('select id from routine_occurrences where id=$1', [run])).rowCount, 0)
  assert.equal((await f.db.query('select id from tasks where id=$1', [task])).rowCount, 0)
  assert.equal((await f.db.query('select id from routines where id=$1', [routine])).rowCount, 1)
  assert.equal((await f.db.query('select id from tasks where id=$1', [templateTask])).rowCount, 1)
  assert.equal((await f.db.query('select id from routine_occurrences where id=$1', [other])).rowCount, 1)
  await assert.rejects(api.deleteRun(f.transfer, run), error => error.status === 404)
})

test('native run mutations reject mismatched names/scopes and ambiguous deletion replies', { skip: !connectionString }, async t => {
  const f = await fixture(t), { MobileApi } = f.load(['mobile/src/services/api.ts'])
  const api = new MobileApi('https://fixture.cyntch.test', f.owner, f.scope.deviceId, async () => 'fixture')
  const run = randomUUID(), original = global.fetch
  let reply
  global.fetch = async () => Response.json(reply)
  t.after(() => { global.fetch = original })
  for (const occurrence of [null, { id: run, household_id: f.shared, title: 'Name' }, { id: randomUUID(), household_id: f.transfer, title: 'Name' }, { id: run, household_id: f.transfer, title: 'Wrong' }]) {
    reply = { occurrence }; await assert.rejects(api.renameRun(f.transfer, run, 'Name'), /did not match/)
  }
  for (const value of [false, null, 'true']) { reply = { ok: value }; await assert.rejects(api.deleteRun(f.transfer, run), /not confirmed/) }
})
