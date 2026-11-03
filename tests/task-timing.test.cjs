/* eslint-disable @typescript-eslint/no-require-imports -- Shared mobile/server rules, no live services. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync, transformSync } = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const filename = path.resolve(__dirname, 'timing-entry.cjs')
const loaded = new Module(filename, module)
loaded._compile(buildSync({ stdin: { contents: `export * from './shared/scheduling'; export * from './lib/time-rules'; export * from './lib/routine-planner'; export * from './lib/billing-policy';`, resolveDir: path.resolve(__dirname, '..'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, filename)
const { resolveUnlockAt, resolveExpiryAt, validateTaskTiming, plannerTaskSchema } = loaded.exports
const iso = value => value?.toISOString()
const resolve = (rule, generation, zone) => iso(resolveUnlockAt(rule, new Date(generation), zone))

test('timing validation rejects malformed input on the client and API without coercing it', () => {
  const valid = { unlockRule: { kind: 'fixed', date: '2028-02-29', time: '23:59' }, expiryRule: null, unlockCombiner: 'and' }
  assert.doesNotThrow(() => validateTaskTiming(valid))
  const base = { taskId: 'b98ce792-81b7-4ceb-bbb2-1a17c8134901', routineId: '41147524-744a-4565-9e9c-f1e3966596d7', isNew: true, title: 'Task', notes: '', isReward: false, assigneeIds: [], prerequisiteIds: [] }
  for (const timing of [null, {}, { ...valid, unlockCombiner: 'xor' }, ...[
    { kind: 'fixed', date: '2026-02-29' }, { kind: 'fixed', date: '2026-04-31' },
    { kind: 'fixed', date: '2026-11-03', time: '24:00' }, { kind: 'after_generation_days', days: '2' },
    { kind: 'weekday_after_generation', weekday: 7, nth: 1 }, { kind: 'weekday_after_generation', weekday: 1, nth: 0 },
    { kind: 'month_day_after_generation', dayOfMonth: 32 }, { kind: 'after_unlock', amount: 1, unit: 'hours' },
  ].map(unlockRule => ({ ...valid, unlockRule }))]) {
    assert.throws(() => validateTaskTiming(timing))
    assert.equal(plannerTaskSchema.safeParse({ ...base, timing }).success, false)
  }
  assert.equal(plannerTaskSchema.safeParse(base).success, true, 'older/basic clients may omit timing')
  assert.throws(() => validateTaskTiming({ ...valid, expiryRule: { kind: 'after_unlock', amount: 52560000, unit: 'days' } }), /Duration/)
  assert.throws(() => validateTaskTiming({ ...valid, expiryRule: { kind: 'after_unlock', amount: 1, unit: ['days'] } }), /Choose minutes/)
})

test('days after generation uses the household calendar date on both sides of UTC', () => {
  const rule = { kind: 'after_generation_days', days: 1, time: '09:00' }
  assert.equal(resolve(rule, '2026-11-03T14:30:00Z', 'Australia/Sydney'), '2026-11-04T22:00:00.000Z')
  assert.equal(resolve(rule, '2026-11-04T01:00:00Z', 'Pacific/Honolulu'), '2026-11-04T19:00:00.000Z')
  assert.equal(resolve(rule, '2026-11-03T14:30:00Z', 'UTC'), '2026-11-04T09:00:00.000Z')
})

test('weekday occurrence counts only actual future household instants, including today', () => {
  const rule = { kind: 'weekday_after_generation', weekday: 2, nth: 1, time: '09:00' }
  assert.equal(resolve(rule, '2026-11-02T21:00:00Z', 'Australia/Sydney'), '2026-11-02T22:00:00.000Z')
  assert.equal(resolve(rule, '2026-11-03T00:00:00Z', 'Australia/Sydney'), '2026-11-09T22:00:00.000Z')
  assert.equal(resolve({ ...rule, nth: 2 }, '2026-11-02T21:00:00Z', 'Australia/Sydney'), '2026-11-09T22:00:00.000Z')
  assert.equal(resolve(rule, '2026-11-02T22:00:01Z', 'Australia/Sydney'), '2026-11-09T22:00:00.000Z')
})

test('month-day rules skip elapsed times and clamp to the last day of short months', () => {
  assert.equal(resolve({ kind: 'month_day_after_generation', dayOfMonth: 4, time: '00:00' }, '2026-11-03T14:30:00Z', 'Australia/Sydney'), '2026-12-03T13:00:00.000Z')
  assert.equal(resolve({ kind: 'month_day_after_generation', dayOfMonth: 31, time: '09:00' }, '2026-02-01T00:00:00Z', 'Australia/Sydney'), '2026-02-27T22:00:00.000Z')
})

test('daylight-saving gaps move forward and folds choose the first occurrence, including half-hour transitions', () => {
  const fixed = (date, time, zone) => resolve({ kind: 'fixed', date, time }, '2026-01-01T00:00:00Z', zone)
  assert.equal(fixed('2026-03-08', '01:30', 'America/New_York'), '2026-03-08T06:30:00.000Z')
  assert.equal(fixed('2026-03-08', '02:30', 'America/New_York'), '2026-03-08T07:30:00.000Z')
  assert.equal(fixed('2026-03-08', '03:30', 'America/New_York'), '2026-03-08T07:30:00.000Z')
  assert.equal(fixed('2026-11-01', '01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z')
  assert.equal(fixed('2026-10-04', '02:30', 'Australia/Sydney'), '2026-10-03T16:30:00.000Z')
  assert.equal(fixed('2026-04-05', '02:30', 'Australia/Sydney'), '2026-04-04T15:30:00.000Z')
  assert.equal(fixed('2026-10-04', '02:15', 'Australia/Lord_Howe'), '2026-10-03T15:45:00.000Z')
  assert.equal(fixed('2026-04-05', '01:45', 'Australia/Lord_Howe'), '2026-04-04T14:45:00.000Z')
})

test('availability-based expiry waits for actual availability and cannot resolve earlier than it', () => {
  const baseline = { generationAt: new Date('2026-11-01T00:00:00Z'), createdAt: new Date('2026-11-01T00:00:00Z'), unlockAt: new Date('2026-11-03T00:00:00Z'), timeZone: 'Australia/Sydney' }
  assert.equal(iso(resolveExpiryAt({ ...baseline, rule: { kind: 'weekday_after_unlock', weekday: 2, nth: 1, time: '09:00' } })), '2026-11-09T22:00:00.000Z')
  assert.equal(iso(resolveExpiryAt({ ...baseline, rule: { kind: 'month_day_after_unlock', dayOfMonth: 3, time: '09:00' } })), '2026-12-02T22:00:00.000Z')
  assert.equal(resolveExpiryAt({ ...baseline, unlockAt: null, rule: { kind: 'after_unlock', amount: 2, unit: 'hours' } }), null)
  assert.equal(iso(resolveExpiryAt({ ...baseline, rule: { kind: 'after_unlock', amount: 2, unit: 'hours' } })), '2026-11-03T02:00:00.000Z')
  assert.equal(iso(resolveExpiryAt({ ...baseline, rule: { kind: 'after_creation', amount: 1, unit: 'days' } })), '2026-11-02T00:00:00.000Z')
})

test('Free cannot bypass automation entitlement with nested timing, but can clear retained rules', async () => {
  class EntitlementError extends Error { constructor(message, status) { super(message); this.status = status } }
  let tier = 'free'
  const entitlement = new Module(filename, module)
  entitlement.require = id => id === '@/lib/billing-policy' ? loaded.exports : id === '@/lib/entitlements' ? {
    EntitlementError, getHouseholdEntitlement: async () => ({ tier, limits: {} }), assertTemplateItemCapacity: async () => {},
  } : require(id)
  entitlement._compile(transformSync(fs.readFileSync(path.resolve(__dirname, '../lib/flow-entitlements.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code, filename)
  const client = { query: async () => ({ rowCount: 1, rows: [{ routine_id: 'routine', routine_occurrence_id: null }] }) }
  const run = timing => entitlement.exports.enforceFlowEntitlements(client, 'household', { action: 'updateTask', taskId: 'task', timing })
  for (const timing of [{ unlockRule: { kind: 'fixed', date: '2026-11-03' } }, { expiryRule: { kind: 'after_unlock', amount: 1, unit: 'hours' } }]) await assert.rejects(run(timing), error => error.status === 402)
  await run(undefined); await run({ unlockRule: null, expiryRule: null, unlockCombiner: 'and' })
  tier = 'premium'; await run({ unlockRule: { kind: 'fixed', date: '2026-11-03' } })
})
