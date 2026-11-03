/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS harness compiles TypeScript modules with isolated dependency mocks. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const filename = path.join(__dirname, '../lib/billing-policy.ts')
const compiled = buildSync({entryPoints:[filename], bundle:true, platform:'node', format:'cjs', write:false})
const loaded = new Module(filename, module)
loaded._compile(compiled.outputFiles[0].text, filename)
const { resolveHouseholdTier, householdLimits, hasTimeRule } = loaded.exports
const now = new Date('2026-11-03T00:00:00Z')

test('owner remains entitled regardless of subscription lifecycle', () => {
  for (const subscriptionStatus of ['none','active','past_due','canceled','unpaid','incomplete','incomplete_expired']) {
    assert.equal(resolveHouseholdTier({ownerGrant:true, subscriptionStatus, paidThrough:null}, now), 'owner')
  }
})
test('paid access expires exactly at paid-through and never trusts status alone', () => {
  for (const subscriptionStatus of ['active','past_due','canceled']) {
    assert.equal(resolveHouseholdTier({ownerGrant:false, subscriptionStatus, paidThrough:'2026-11-04'}, now), 'premium')
    assert.equal(resolveHouseholdTier({ownerGrant:false, subscriptionStatus, paidThrough:now}, now), 'free')
    assert.equal(resolveHouseholdTier({ownerGrant:false, subscriptionStatus, paidThrough:'invalid'}, now), 'free')
  }
  assert.equal(resolveHouseholdTier({ownerGrant:false, subscriptionStatus:'incomplete', paidThrough:'2027-01-01'}, now), 'free')
})
test('free limits cannot be enlarged through premium configuration', () => {
  assert.deepEqual(householdLimits('free', {PREMIUM_MAX_ITEMS:'1000'}), {templates:1,items:15,activeExecutions:1,automation:false})
  assert.equal(householdLimits('premium', {PREMIUM_MAX_ITEMS:'999999'}).items, 1000)
  assert.equal(householdLimits('premium', {PREMIUM_MAX_ITEMS:'-1'}).items, 100)
})
test('time rules are conservative and explicit none is allowed', () => {
  for (const value of [null,undefined,'',{kind:'none'},'{"kind":"none"}']) assert.equal(hasTimeRule(value), false)
  for (const value of [{kind:'fixed'}, {kind:'after_unlock'}, {}, [], 'bad-json', 1]) assert.equal(hasTimeRule(value), true)
})
