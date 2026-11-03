/* eslint-disable @typescript-eslint/no-require-imports -- Contract tests with controlled HTTP responses; no real push. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const Module = require('node:module')
const { buildSync } = require('esbuild')
const filename = path.resolve(__dirname, '../lib/expo-push-provider.ts'), loaded = new Module(filename, module)
loaded._compile(buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, filename)
const { createExpoPushProvider } = loaded.exports

test('Expo sends bounded batches with protected authentication, maps tickets in order and filters receipt IDs', async () => {
  const requests = []
  const provider = createExpoPushProvider('secret-access', async (url, options) => {
    requests.push({ url, options })
    return Response.json({ data: url.endsWith('/send') ? [{ status: 'ok', id: 'ticket-1' }, { status: 'error', message: 'TOKEN must never escape', details: { error: 'DeviceNotRegistered' } }]
      : { 'ticket-1': { status: 'ok' }, unrelated: { status: 'ok' } } })
  })
  const messages = [{ to: 'ExpoPushToken[a]' }, { to: 'ExpoPushToken[b]' }]
  assert.deepEqual(await provider.send(messages), [{ status: 'ok', id: 'ticket-1' }, { status: 'error', code: 'DeviceNotRegistered' }])
  assert.deepEqual(await provider.receipts(['ticket-1', 'not-ready']), { 'ticket-1': { status: 'ok' } })
  assert.equal(requests[0].url, 'https://exp.host/--/api/v2/push/send')
  assert.equal(requests[1].url, 'https://exp.host/--/api/v2/push/getReceipts')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-access')
  assert.ok(requests[0].options.signal instanceof AbortSignal)
  assert.deepEqual(JSON.parse(requests[0].options.body), messages)
  await assert.rejects(provider.send(Array(101).fill(messages[0])), /MessageTooBig/)
  await assert.rejects(provider.send([{ ...messages[0], body: 'x'.repeat(4096) }]), /MessageTooBig/)
  await assert.rejects(provider.receipts(Array(1001).fill('ticket')), /TooManyReceipts/)
  assert.equal(requests.length, 2, 'invalid requests never leave the process')
})

test('Expo network, HTTP and malformed responses become controlled errors without leaking provider text or tokens', async () => {
  for (const [status, code, retryable] of [[429, 'RateLimited', true], [503, 'ProviderUnavailable', true], [401, 'InvalidCredentials', true], [400, 'RequestRejected', false]]) {
    const provider = createExpoPushProvider(undefined, async () => new Response('TOKEN', { status }))
    await assert.rejects(provider.send([{ to: 'TOKEN' }]), error => error.message === code && error.retryable === retryable)
  }
  const network = createExpoPushProvider(undefined, async () => { throw new Error('TOKEN') })
  await assert.rejects(network.send([{ to: 'TOKEN' }]), /NetworkUnavailable/)
  for (const data of [null, []]) {
    const provider = createExpoPushProvider(undefined, async () => Response.json({ data }))
    await assert.rejects(provider.send([{ to: 'TOKEN' }]), error => /Invalid/.test(error.message) && !error.message.includes('TOKEN'))
  }
  const partial = createExpoPushProvider(undefined, async url => Response.json({ data: url.endsWith('/send')
    ? [{ status: 'ok', id: 'valid-ticket' }, { status: 'ok' }, { status: 'unrecognized' }]
    : { valid: { status: 'ok' }, invalid: { status: 'unrecognized' } } }))
  assert.deepEqual(await partial.send([{ to: 'a' }, { to: 'b' }, { to: 'c' }]),
    [{ status: 'ok', id: 'valid-ticket' }, { status: 'error', code: 'InvalidTicket' }, { status: 'error', code: 'InvalidResponse' }])
  assert.deepEqual(await partial.receipts(['valid', 'invalid']), { valid: { status: 'ok' } })
})
