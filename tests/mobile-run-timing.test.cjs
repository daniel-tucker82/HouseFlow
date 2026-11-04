/* eslint-disable @typescript-eslint/no-require-imports -- Shared native timing decisions tested without a device. */
const { test } = require('node:test'), assert = require('node:assert/strict')
const { buildSync } = require('esbuild'), Module = require('node:module'), path = require('node:path')
const loaded = new Module(__filename, module)
loaded._compile(buildSync({ entryPoints: [path.resolve(__dirname, '../shared/mobile/run-timing.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, __filename)
const { fixedRuleAt, runTimingInstants, changeRunTaskTiming } = loaded.exports
const task = { unlock_at: '2027-04-03T16:30:45.123Z', expires_at: '2027-04-04T03:00:00Z' }
const draft = { taskId: 'task', occurrenceId: 'run', title: 'Bag', isNew: false }
const original = { unlockRule: { kind: 'after_generation_days', days: 1, time: '02:30' }, expiryRule: { kind: 'after_creation', amount: 2, unit: 'days' }, unlockCombiner: 'and' }

test('fixed controls use household wall dates across timezone and DST boundaries', () => {
  assert.deepEqual(fixedRuleAt('2026-11-04T20:45:00Z', 'Australia/Sydney'), { kind: 'fixed', date: '2026-11-05', time: '07:45' })
  assert.deepEqual(fixedRuleAt('2026-11-04T01:30:00Z', 'America/Los_Angeles'), { kind: 'fixed', date: '2026-11-03', time: '17:30' })
  assert.deepEqual(fixedRuleAt(task.unlock_at, 'Australia/Sydney'), { kind: 'fixed', date: '2027-04-04', time: '02:30' })
  assert.equal(fixedRuleAt(null, 'UTC'), null); assert.equal(fixedRuleAt('invalid', 'UTC'), null)
})

test('expiry and combiner edits retain the exact activation instant, including the later repeated hour', () => {
  const expiry = { ...original, expiryRule: { kind: 'after_creation', amount: 3, unit: 'hours' } }
  const changed = changeRunTaskTiming(draft, task, expiry, 'expiry')
  assert.equal(changed.unlockAtOverride, task.unlock_at); assert.equal(changed.expiryAtOverride, null)
  assert.deepEqual(runTimingInstants(changed, task), { activation: task.unlock_at, expiry: null })
  const combined = changeRunTaskTiming(changed, task, { ...expiry, unlockCombiner: 'or' }, 'combiner')
  assert.equal(combined.unlockAtOverride, task.unlock_at); assert.equal(combined.expiryAtOverride, null)
  assert.deepEqual(draft, { taskId: 'task', occurrenceId: 'run', title: 'Bag', isNew: false })
})

test('changing activation preserves independent expiry and recalculates expiry tied to availability', () => {
  assert.equal(changeRunTaskTiming(draft, task, original, 'activation').expiryAtOverride, task.expires_at)
  for (const kind of ['after_unlock', 'weekday_after_unlock', 'month_day_after_unlock']) {
    const changed = changeRunTaskTiming(draft, task, { ...original, expiryRule: { kind } }, 'activation')
    assert.equal(changed.unlockAtOverride, null); assert.equal(changed.expiryAtOverride, null)
  }
})

test('successive edits and clearing never resurrect the original resolved times', () => {
  const first = changeRunTaskTiming(draft, task, original, 'activation')
  const second = changeRunTaskTiming(first, task, original, 'expiry')
  assert.equal(second.unlockAtOverride, null); assert.equal(second.expiryAtOverride, null)
  const cleared = changeRunTaskTiming(draft, task, { unlockRule: null, expiryRule: null, unlockCombiner: 'and' }, 'all')
  assert.deepEqual(runTimingInstants(cleared, task), { activation: null, expiry: null })
  assert.deepEqual(runTimingInstants(draft, { scheduled_time: task.unlock_at }), { activation: task.unlock_at, expiry: null })
  assert.deepEqual(runTimingInstants(draft), { activation: null, expiry: null })
})
