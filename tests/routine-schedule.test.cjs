/* eslint-disable @typescript-eslint/no-require-imports -- Shared validation and semantic comparison. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const file = path.resolve(__dirname, '../shared/routine-schedule.ts'), loaded = new Module(file, module)
loaded._compile(buildSync({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, file)
const { validateRoutineSchedule, sameRoutineSchedule, scheduleForRoutine, onlyReducesAutomation } = loaded.exports
const daily = { id: 'daily', frequency: 'daily', interval: 1, time: '09:00', startDate: '2026-11-04' }
const schedule = rules => ({ rules, completeOlderOccurrencesOnNew: false })

test('all recurrence patterns validate, while malformed schedules and client watermarks are rejected', () => {
  for (const rule of [daily, { ...daily, frequency: 'weekly', weekday: 'monday' },
    { ...daily, frequency: 'monthly', monthlyMode: 'specific_date', dayOfMonth: 31 },
    { ...daily, frequency: 'monthly', monthlyMode: 'nth', nth: '3rd', weekday: 'friday' },
    { ...daily, frequency: 'yearly', yearlyMode: 'specific_date', month: 2, day: 29 },
    { ...daily, frequency: 'yearly', yearlyMode: 'nth', nth: '52th', weekday: 'sunday' }]) assert.doesNotThrow(() => validateRoutineSchedule(schedule([rule])))
  for (const patch of [{ interval: null }, { interval: '2' }, { time: '24:00' }, { startDate: '2026-02-30' }, { id: '' },
    { lastGeneratedAt: '2030-01-01T00:00:00Z' }, { frequency: 'weekly', weekday: 'funday' },
    { frequency: 'monthly', monthlyMode: 'nth', nth: '5th', weekday: 'monday' },
    { frequency: 'yearly', yearlyMode: 'nth', nth: '53th', weekday: 'monday' },
    { frequency: 'yearly', yearlyMode: 'specific_date', month: 13, day: 1 }]) assert.throws(() => validateRoutineSchedule(schedule([{ ...daily, ...patch }])))
  for (const bad of [null, {}, { rules: [], completeOlderOccurrencesOnNew: 'true' }, schedule([daily, daily]), schedule(Array.from({ length: 101 }, (_, i) => ({ ...daily, id: String(i) })))]) assert.throws(() => validateRoutineSchedule(bad))
})

test('comparison ignores scheduler metadata, rule order and irrelevant fields, but detects every meaningful edit', () => {
  const weekly = { ...daily, id: 'weekly', frequency: 'weekly', weekday: 'monday' }
  const stored = scheduleForRoutine({ recurrence_rule: JSON.stringify([{ ...daily, lastGeneratedAt: '2026-11-04T09:00:00Z' }, weekly]), complete_older_occurrences_on_new: false })
  assert.equal(sameRoutineSchedule(stored, schedule([{ ...weekly, month: 8 }, daily])), true)
  for (const patch of [{ time: '10:00' }, { interval: 2 }, { startDate: '2026-11-05' }, { id: 'replacement' }]) assert.equal(sameRoutineSchedule(stored, schedule([{ ...daily, ...patch }, weekly])), false)
  assert.equal(sameRoutineSchedule(stored, { ...stored, completeOlderOccurrencesOnNew: true }), false)
  assert.equal(Object.hasOwn(stored.rules[0], 'lastGeneratedAt'), false)
})

test('downgraded households can retain or remove rules and disable completion, without enabling or changing automation', () => {
  const current = { ...schedule([daily, { ...daily, id: 'second', time: '18:00' }]), completeOlderOccurrencesOnNew: true }
  assert.equal(onlyReducesAutomation(current, current), true)
  assert.equal(onlyReducesAutomation(current, schedule([daily])), true)
  assert.equal(onlyReducesAutomation(current, schedule([])), true)
  assert.equal(onlyReducesAutomation(current, schedule([{ ...daily, time: '10:00' }])), false)
  assert.equal(onlyReducesAutomation(current, schedule([{ ...daily, id: 'new' }])), false)
  assert.equal(onlyReducesAutomation(schedule([]), { ...schedule([]), completeOlderOccurrencesOnNew: true }), false)
})
