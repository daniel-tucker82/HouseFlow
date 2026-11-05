/* eslint-disable @typescript-eslint/no-require-imports -- Real native transport, routes and isolated PostgreSQL schemas. */
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto')
const { fixture, connectionString } = require('./helpers/account-deletion.cjs')

async function setup(t) {
  const f = await fixture(t)
  const mocks = { 'next/server': { NextResponse: { json: Response.json }, after() {} },
    'next/navigation': { redirect() { assert.fail('Unexpected redirect') } },
    '@/lib/user-sync': { ensureCurrentUserRecord: async () => {} }, '@/lib/push': { dispatchPushForNotificationIds: async () => {} } }
  const { GET } = f.load(['app/api/mobile/invitations/route.ts'], mocks)
  const { POST } = f.load(['app/api/leader/flow/route.ts'], mocks)
  const { acceptInviteByCode } = f.load(['lib/actions/household.ts'], mocks)
  const { MobileApi } = f.load(['mobile/src/services/api.ts'])
  const api = new MobileApi('https://fixture.cyntch.test', f.owner, f.scope.deviceId, async () => 'fixture', async () => f.secret, f.scope.sessionId)
  const oldFetch = global.fetch
  global.fetch = async (url, init) => {
    assert.equal(new URL(url).origin, 'https://fixture.cyntch.test', 'No external traffic is allowed')
    return (new URL(url).pathname === '/api/mobile/invitations' ? GET : POST)(new Request(url, init))
  }
  t.after(() => { global.fetch = oldFetch })
  return { ...f, api, GET, acceptInviteByCode, send: (action, values = {}) => api.request('/api/leader/flow', { action, householdId: f.deleting, ...values }) }
}

test('mobile invitations validate limits, survive a fresh read, consume uses and revoke without removing members', { skip: !connectionString }, async t => {
  const f = await setup(t)
  assert.deepEqual((await f.api.invitations(f.deleting)).items, [])
  for (const values of [{ maxUses: 0 }, { maxUses: 101 }, { maxUses: 1.5 }, { maxUses: 'invalid' }, { expiresInDays: 0 }, { expiresInDays: 366 }, { expiresInDays: 1.5 }]) {
    await assert.rejects(f.send('createInvite', values), e => e.status === 400)
  }
  const { invite } = await f.send('createInvite', { maxUses: 2, expiresInDays: 7 })
  const page = await f.api.invitations(f.deleting), saved = page.items[0]
  assert.equal(page.accountId, f.owner); assert.equal(page.householdId, f.deleting)
  assert.equal(saved.id, invite.id); assert.equal(saved.maxUses, 2); assert.equal(saved.usesCount, 0); assert.equal(saved.status, 'available')
  assert.ok(Math.abs(Date.parse(saved.expiresAt) - Date.now() - 7 * 86400000) < 5000)
  f.identity.userId = f.other
  await f.acceptInviteByCode(invite.code, f.other)
  await f.acceptInviteByCode(invite.code, f.other)
  f.identity.userId = f.owner
  assert.equal((await f.api.invitations(f.deleting)).items[0].usesCount, 1, 'Rejoining does not consume another use')
  await assert.rejects(f.send('deactivateInvite', { inviteId: 'malformed' }), e => e.status === 400)
  await assert.rejects(f.send('deactivateInvite', { householdId: f.transfer, inviteId: invite.id }), e => e.status === 404)
  await f.send('deactivateInvite', { inviteId: invite.id })
  await f.send('deactivateInvite', { inviteId: invite.id })
  assert.deepEqual((await f.api.invitations(f.deleting)).items, [])
  assert.equal((await f.db.query('select count(*)::int n from household_members where household_id=$1 and user_id=$2', [f.deleting, f.other])).rows[0].n, 1)
  f.identity.userId = f.successor
  await assert.rejects(f.acceptInviteByCode(invite.code, f.successor), /expired or is inactive/)
})

test('invitation reads paginate tied timestamps and enforce household roles, sign-in and kiosk locks', { skip: !connectionString }, async t => {
  const f = await setup(t)
  const ids = []
  for (let i = 0; i < 28; i++) {
    const id = randomUUID(); ids.push(id)
    await f.db.query("insert into household_invites(id,household_id,created_by,code,expires_at,max_uses,uses_count,created_at) values($1::uuid,$2,$3,$1::text,now()+($4::int * interval '1 day'),1,$5,'2026-01-01T00:00:00.123456Z')",
      [id, f.deleting, f.owner, i === 0 ? -1 : 1, i === 1 ? 1 : 0])
  }
  const page1 = await f.api.invitations(f.deleting), page2 = await f.api.invitations(f.deleting, page1.nextCursor)
  assert.equal(page1.items.length, 25); assert.equal(page2.items.length, 3); assert.equal(page2.nextCursor, null)
  const items = [...page1.items, ...page2.items]
  assert.deepEqual(items.map(x => x.id).sort(), ids.sort())
  assert.equal(items.filter(x => x.status === 'expired').length, 1); assert.equal(items.filter(x => x.status === 'used').length, 1)
  assert.deepEqual((await f.api.invitations(f.transfer)).items, [], 'Other household links are not included')
  for (const cursor of ['not-a-cursor', Buffer.from(JSON.stringify({ time: '2026-02-31T00:00:00.123456Z', id: randomUUID() })).toString('base64url')]) {
    await assert.rejects(f.api.invitations(f.deleting, cursor), e => e.status === 400)
  }
  await assert.rejects(f.api.invitations(randomUUID()), e => e.status === 403)
  for (const role of ['supervisor', 'member']) {
    await f.db.query('update household_members set role=$1 where household_id=$2 and user_id=$3', [role, f.deleting, f.owner])
    await assert.rejects(f.api.invitations(f.deleting), e => e.status === 403)
    await assert.rejects(f.send('createInvite'), e => e.status === 403)
    await assert.rejects(f.send('deactivateInvite', { inviteId: ids[0] }), e => e.status === 403)
  }
  await f.db.query("update household_members set role='manager' where household_id=$1 and user_id=$2", [f.deleting, f.owner])
  const response = await f.GET(new Request(`https://fixture.cyntch.test/api/mobile/invitations?householdId=${f.deleting}`))
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  f.identity.userId = null
  assert.equal((await f.GET(new Request(`https://fixture.cyntch.test/api/mobile/invitations?householdId=${f.deleting}`))).status, 401)
  f.identity.userId = f.owner
  await f.db.query('insert into native_kiosk_sessions(id,user_id,session_id,device_id,household_id,visible_member_ids,editable_member_ids,exit_secret_hash,request_hash) values($1,$2,$3,$4,$5,array[$2],array[$2],$6,$6)',
    [randomUUID(), f.owner, f.scope.sessionId, f.scope.deviceId, f.deleting, 'b'.repeat(64)])
  await assert.rejects(f.api.invitations(f.deleting), e => e.status === 423)
  await assert.rejects(f.send('createInvite'), e => e.status === 423)
  await assert.rejects(f.send('deactivateInvite', { inviteId: ids[0] }), e => e.status === 423)
})
