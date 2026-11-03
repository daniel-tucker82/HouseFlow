/* eslint-disable @typescript-eslint/no-require-imports -- Shared calendar rules tested without live services. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const Module = require('node:module')
const path = require('node:path')
const entry = path.resolve(__dirname, 'recurrence-entry.cjs')
const loaded = new Module(entry, module)
loaded._compile(buildSync({ entryPoints: [path.resolve(__dirname, '../lib/recurrence.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text, entry)
const { nextRecurrenceDate, latestRecurrenceAtOrBefore, anchorRecurrenceRule, createDefaultRecurrenceRule, normalizeRecurrenceRule } = loaded.exports
const rule = patch => ({ id: 'schedule', frequency: 'daily', interval: 1, time: '09:00', startDate: '2026-01-01', ...patch })
const iso = date => date?.toISOString() ?? null
const next = (value, now, zone = 'UTC') => iso(nextRecurrenceDate(value, new Date(now), zone))
const latest = (value, now, zone = 'UTC') => iso(latestRecurrenceAtOrBefore(value, new Date(now), zone))

test('daily recurrence follows the household date on both sides of UTC and includes the exact due instant', () => {
  const value = rule({})
  assert.equal(next(value, '2026-11-03T21:59:59Z', 'Australia/Sydney'), '2026-11-03T22:00:00.000Z')
  assert.equal(latest(value, '2026-11-03T21:59:59Z', 'Australia/Sydney'), '2026-11-02T22:00:00.000Z')
  assert.equal(latest(value, '2026-11-03T22:00:00Z', 'Australia/Sydney'), '2026-11-03T22:00:00.000Z')
  assert.equal(next(value, '2026-11-03T22:00:00Z', 'Australia/Sydney'), '2026-11-04T22:00:00.000Z')
  assert.equal(next(value, '2026-11-04T01:00:00Z', 'Pacific/Honolulu'), '2026-11-04T19:00:00.000Z')
  assert.equal(latest(value, '2026-11-04T01:00:00Z', 'Pacific/Honolulu'), '2026-11-03T19:00:00.000Z')
})

test('DST gaps shift forward and folds run once, using actual instants rather than wall-clock comparisons', () => {
  const spring = rule({ time: '02:30' })
  assert.equal(next(spring, '2026-03-08T07:15:00Z', 'America/New_York'), '2026-03-08T07:30:00.000Z', '03:15 wall time is before the shifted 03:30 occurrence')
  assert.equal(latest(spring, '2026-03-08T07:15:00Z', 'America/New_York'), '2026-03-07T07:30:00.000Z')
  assert.equal(latest(spring, '2026-03-08T07:30:00Z', 'America/New_York'), '2026-03-08T07:30:00.000Z')
  assert.equal(next(spring, '2026-03-08T07:30:00Z', 'America/New_York'), '2026-03-09T06:30:00.000Z')
  const fall = rule({ time: '01:30' })
  assert.equal(latest(fall, '2026-11-01T06:10:00Z', 'America/New_York'), '2026-11-01T05:30:00.000Z', 'during the second 01:10 the first 01:30 is already past')
  assert.equal(next(fall, '2026-11-01T06:10:00Z', 'America/New_York'), '2026-11-02T06:30:00.000Z')
  assert.equal(next(rule({ time: '02:15' }), '2026-10-03T15:40:00Z', 'Australia/Lord_Howe'), '2026-10-03T15:45:00.000Z')
  assert.equal(latest(rule({ time: '01:45' }), '2026-04-04T15:10:00Z', 'Australia/Lord_Howe'), '2026-04-04T14:45:00.000Z')
})

test('daily and weekly interval phases remain stable through DST and long gaps', () => {
  const daily = rule({ startDate: '2026-03-01', interval: 2 })
  assert.equal(next(daily, '2026-03-08T12:00:00Z', 'America/New_York'), '2026-03-09T13:00:00.000Z')
  assert.equal(latest(daily, '2026-03-08T12:00:00Z', 'America/New_York'), '2026-03-07T14:00:00.000Z')
  const weekly = rule({ frequency: 'weekly', interval: 2, weekday: 'sunday', startDate: '2026-03-01' })
  assert.equal(next(weekly, '2026-03-08T12:00:00Z', 'America/New_York'), '2026-03-15T13:00:00.000Z')
  assert.equal(latest(weekly, '2026-03-08T12:00:00Z', 'America/New_York'), '2026-03-01T14:00:00.000Z')
  const ancient = rule({ startDate: '2000-01-01', interval: 3 })
  // Nov 1 and Nov 4 are 9,801 and 9,804 calendar days after the anchor.
  assert.equal(next(ancient, '2026-11-03T10:00:00Z'), '2026-11-04T09:00:00.000Z')
  assert.equal(latest(ancient, '2026-11-03T10:00:00Z'), '2026-11-01T09:00:00.000Z')
})

test('monthly ordinals, last weekdays and short-month dates retain their meaning', () => {
  const monthly = rule({ frequency: 'monthly', monthlyMode: 'nth', weekday: 'monday' })
  for (const [nth, day] of [['1st', '02'], ['2nd', '09'], ['3rd', '16'], ['4th', '23'], ['last', '30']]) {
    assert.equal(next({ ...monthly, nth }, '2026-11-01T00:00:00Z'), `2026-11-${day}T09:00:00.000Z`)
  }
  const monthEnd = rule({ frequency: 'monthly', monthlyMode: 'specific_date', dayOfMonth: 31 })
  assert.equal(next(monthEnd, '2026-02-01T00:00:00Z'), '2026-02-28T09:00:00.000Z')
  assert.equal(next(monthEnd, '2028-02-01T00:00:00Z'), '2028-02-29T09:00:00.000Z')
  assert.equal(next({ ...monthEnd, interval: 3 }, '2026-02-01T00:00:00Z'), '2026-04-30T09:00:00.000Z')
  assert.equal(latest({ ...monthEnd, startDate: '2026-02-28' }, '2026-02-27T12:00:00Z'), null)
})

test('yearly dates clamp within their month and nth weekdays are counted within the year', () => {
  const leap = rule({ frequency: 'yearly', yearlyMode: 'specific_date', month: 2, day: 29 })
  assert.equal(next(leap, '2026-01-01T00:00:00Z'), '2026-02-28T09:00:00.000Z')
  assert.equal(next(leap, '2028-01-01T00:00:00Z'), '2028-02-29T09:00:00.000Z')
  const ordinal = rule({ frequency: 'yearly', yearlyMode: 'nth', weekday: 'monday', nth: '2th' })
  assert.equal(next(ordinal, '2026-01-01T00:00:00Z'), '2026-01-12T09:00:00.000Z')
  assert.equal(next({ ...ordinal, nth: 'last' }, '2026-01-01T00:00:00Z'), '2026-12-28T09:00:00.000Z')
  assert.equal(next({ ...leap, startDate: '2027-06-01' }, '2026-01-01T00:00:00Z'), '2028-02-29T09:00:00.000Z', 'never schedule before a future anchor')
})

test('missing anchors become stable household dates and existing generation watermarks remain intact', () => {
  const now = new Date('2026-11-03T14:00:00Z')
  const value = rule({ startDate: undefined, interval: 3 })
  const anchored = anchorRecurrenceRule(value, now, 'Australia/Sydney')
  assert.equal(anchored.startDate, '2026-11-04')
  assert.equal(anchorRecurrenceRule(anchored, new Date('2026-11-06T00:00:00Z'), 'Australia/Sydney'), anchored)
  const generated = { ...value, lastGeneratedAt: '2026-11-01T22:00:00Z' }
  const recovered = anchorRecurrenceRule(generated, now, 'Australia/Sydney')
  assert.equal(recovered.startDate, '2026-11-02')
  assert.equal(recovered.lastGeneratedAt, generated.lastGeneratedAt)
  assert.equal(createDefaultRecurrenceRule('Australia/Sydney', now).startDate, '2026-11-04')
})

test('invalid dates, times and intervals fail closed; older saved input normalizes safely', () => {
  for (const patch of [{ startDate: '2026-02-30' }, { time: '24:00' }, { time: '09:99' }, { interval: 0 }, { interval: Infinity }, { interval: 1.5 }]) {
    assert.equal(next(rule(patch), '2026-01-01T00:00:00Z'), null)
    assert.equal(latest(rule(patch), '2026-01-01T00:00:00Z'), null)
  }
  assert.equal(normalizeRecurrenceRule({ time: '24:00' }).time, '09:00')
  assert.equal(normalizeRecurrenceRule({ startDate: '2026-02-30' }).startDate, undefined)
})

test('explicit household timezone produces identical answers regardless of the host timezone', () => {
  const saved = process.env.TZ
  try {
    const results = ['UTC', 'Pacific/Honolulu', 'Asia/Kolkata', 'Australia/Sydney'].map(host => {
      process.env.TZ = host
      return [next(rule({}), '2026-11-03T21:00:00Z', 'Australia/Sydney'), latest(rule({}), '2026-11-03T21:00:00Z', 'Australia/Sydney')]
    })
    for (const result of results) assert.deepEqual(result, results[0])
  } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved }
})
