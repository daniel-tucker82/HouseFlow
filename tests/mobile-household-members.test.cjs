/* eslint-disable @typescript-eslint/no-require-imports -- Real native transport and PostgreSQL household permissions. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const path = require('node:path'), Module = require('node:module'), { buildSync } = require('esbuild')
const { fixture, connectionString } = require('./helpers/account-deletion.cjs')

test('native member colours retain web assignments, explicit choices and readable initials', () => {
  const loaded = new Module(__filename, module)
  loaded._compile(buildSync({ stdin: { contents: 'export * from "./shared/member-tokens"', resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, __filename)
  const { buildMemberTokenColorMap, buildNativeMemberColorMap, NATIVE_TOKEN_COLOR_OPTIONS } = loaded.exports
  const members = [{ id: 'alex' }, { id: 'sam', token_color: 'rose' }, { id: 'parent', token_color: 'blue' }, { id: 'legacy', token_color: 'unknown' },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `member-${i}` }))]
  const before = JSON.stringify(members), web = buildMemberTokenColorMap(members), native = buildNativeMemberColorMap(members)
  assert.equal(native.get('alex').id, 'amber', 'automatic assignments reserve explicit member colours')
  assert.equal(native.get('sam').id, 'rose'); assert.equal(native.get('parent').id, 'blue')
  for (const member of members) assert.equal(native.get(member.id).className, web.get(member.id))
  assert.equal(JSON.stringify(members), before)
  const luminance = hex => hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
  assert.equal(NATIVE_TOKEN_COLOR_OPTIONS.length, 16)
  for (const option of NATIVE_TOKEN_COLOR_OPTIONS) assert.ok((luminance(option.background) + 0.05) / (luminance(option.foreground) + 0.05) >= 4.5, option.id)
})

test('native household edits respect linked identities, roles, household isolation and kiosk locks', { skip: !connectionString }, async t => {
  const f = await fixture(t)
  const mocks = { 'next/server': { NextResponse: { json: Response.json }, after() {} }, 'next/navigation': { redirect() { assert.fail('Unexpected redirect') } },
    '@/lib/user-sync': { ensureCurrentUserRecord: async () => {} } }
  const { POST } = f.load(['app/api/leader/flow/route.ts'], mocks)
  const { GET } = f.load(['app/api/mobile/bootstrap/route.ts'], mocks)
  const { MobileApi } = f.load(['mobile/src/services/api.ts'])
  const oldFetch = global.fetch
  global.fetch = async (url, init) => {
    assert.equal(new URL(url).origin, 'https://fixture.cyntch.test')
    return (new URL(url).pathname === '/api/mobile/bootstrap' ? GET : POST)(new Request(url, init))
  }
  t.after(() => { global.fetch = oldFetch })
  const api = new MobileApi('https://fixture.cyntch.test', f.owner, f.scope.deviceId, async () => 'fixture', async () => f.secret, f.scope.sessionId)
  const send = (action, values = {}) => api.request('/api/leader/flow', { action, householdId: f.deleting, memberUserId: f.child, ...values })
  const emailOnly = 'local_member_' + randomUUID(), providerWithoutEmail = 'user_' + randomUUID()
  await f.db.query("insert into users(id,full_name,email) values($1,'Email identity','fixture@example.test'),($2,'Provider identity',null)", [emailOnly, providerWithoutEmail])
  await f.db.query("insert into household_members(household_id,user_id,role) values($1,$2,'member'),($1,$3,'member')", [f.deleting, emailOnly, providerWithoutEmail])
  const first = (await api.bootstrap(f.deleting)).board.members
  assert.equal(first.find(m => m.id === f.child).is_clerk_linked, false)
  for (const id of [f.owner, emailOnly, providerWithoutEmail]) {
    assert.equal(first.find(m => m.id === id).is_clerk_linked, true)
    await assert.rejects(send('renameHouseholdMember', { memberUserId: id, name: 'Must not change' }), e => e.status === 400)
  }
  await send('renameHouseholdMember', { name: '  Alex  ' })
  await send('updateMemberTokenColor', { tokenColor: 'violet' })
  const saved = (await api.bootstrap(f.deleting)).board.members.find(m => m.id === f.child)
  assert.equal(saved.name, 'Alex'); assert.equal(saved.token_color, 'violet')
  await assert.rejects(send('renameHouseholdMember', { name: ' ' }), e => e.status === 400)
  await assert.rejects(send('renameHouseholdMember', { householdId: f.transfer, name: 'Wrong household' }), e => e.status === 404)
  await send('updateMemberTokenColor', { householdId: f.transfer, tokenColor: 'red' })
  assert.equal((await api.bootstrap(f.deleting)).board.members.find(m => m.id === f.child).token_color, 'violet')
  await f.db.query("update household_members set role='supervisor' where household_id=$1 and user_id=$2", [f.deleting, f.owner])
  await assert.rejects(send('renameHouseholdMember', { name: 'Supervisor rename' }), e => e.status === 403)
  await send('updateMemberTokenColor', { tokenColor: 'teal' })
  assert.equal((await api.bootstrap(f.deleting)).board.members.find(m => m.id === f.child).token_color, 'teal')
  await send('updateMemberTokenColor', { tokenColor: null })
  assert.equal((await api.bootstrap(f.deleting)).board.members.find(m => m.id === f.child).token_color, null)
  await f.db.query("update household_members set role='member' where household_id=$1 and user_id=$2", [f.deleting, f.owner])
  for (const action of ['renameHouseholdMember', 'updateMemberTokenColor']) await assert.rejects(send(action, { name: 'Blocked', tokenColor: 'red' }), e => e.status === 403)
  await f.db.query("update household_members set role='manager' where household_id=$1 and user_id=$2", [f.deleting, f.owner])
  await f.db.query("insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array[$2],array[$2],$6,$6)",
    [randomUUID(), f.owner, f.scope.sessionId, f.scope.deviceId, f.deleting, 'b'.repeat(64)])
  for (const action of ['renameHouseholdMember', 'updateMemberTokenColor']) await assert.rejects(send(action, { name: 'Locked', tokenColor: 'red' }), e => e.status === 423)
  const retained = (await f.db.query('select u.full_name,hm.token_color from users u join household_members hm on hm.user_id=u.id where hm.household_id=$1 and u.id=$2', [f.deleting, f.child])).rows[0]
  assert.deepEqual(retained, { full_name: 'Alex', token_color: null })
})
