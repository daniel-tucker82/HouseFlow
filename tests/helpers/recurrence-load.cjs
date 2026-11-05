/* eslint-disable @typescript-eslint/no-require-imports -- Opt-in real HTTP/PostgreSQL timing experiment. */
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')

// Runs only inside the recurrence-worker test's new disposable schema, using
// its authenticated local cron endpoint with every delivery provider disabled.
// Use real timers and separate post-response DB reads; PostgreSQL now() inside
// a transaction is its start time, not proof the result was already committed.
module.exports = async function measureRecurrenceLoad(f, tick, evidencePath) {
  const { db, owner, child } = f
  const scope = (await db.query('select current_schema() as schema, current_database() as db, inet_server_port() as port')).rows[0]
  assert.match(scope.schema, /^deletion_[a-f0-9]{32}$/)
  assert.equal(scope.db, 'cyntch_mobile_test'); assert.equal(scope.port, 55439)
  const households = [], samples = [], observed = new Map()
  const report = {
    verified: false, scenario: 'Closed clients; local production HTTP handler, PostgreSQL and two 60-second intervals.',
    fixture: { measuredHouseholds: 8, routinesPerHousehold: 2, activeBoardsPerHousehold: 2,
      ordinaryHouseholds: 6, ordinaryItemsPerBoard: 15, largeHouseholds: 2, largeItemsPerBoard: 100,
      boardItems: 580, expectedTimedTransitions: 192, entitlement: 'Premium', timezone: 'Australia/Sydney' },
    targetMs: 90_000, ticks: [], limits: 'Controlled workload, not production traffic, external scheduler reliability, physical-device latency or remote push delivery.',
  }
  const save = () => fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2) + '\n')
  const request = async label => {
    const start = performance.now(), { response, body } = await tick()
    report.ticks.push({ label, durationMs: Math.round(performance.now() - start), status: response.status,
      householdsProcessed: body.householdsProcessed, householdsFailed: body.householdsFailed,
      budgetExhausted: body.budgetExhausted, occurrencesProcessed: body.occurrencesProcessed,
      tasksUnlocked: body.tasksUnlocked, tasksCompleted: body.tasksCompleted })
    save()
    assert.equal(response.status, 200, `Scheduler failed during ${label}; see ${evidencePath}`)
    assert.equal(body.ok, true)
  }
  const summarize = values => {
    assert.ok(values.length)
    const sorted = [...values].sort((a, b) => a - b)
    return { n: sorted.length, min: sorted[0], median: sorted[Math.ceil(sorted.length * .5) - 1],
      p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) }
  }
  try {
    await db.query(`create table cyntch_load_cases(task_id uuid primary key, wave int not null,
      kind text not null, offset_ms int not null, due_at timestamptz)`)
    for (let h = 0; h < 8; h++) {
      const household = randomUUID(), itemCount = h < 6 ? 15 : 100
      households.push(household)
      await db.query("insert into households(id,name,leader_id,timezone) values($1,'Load fixture',$2,'Australia/Sydney')", [household, owner])
      await db.query("insert into household_members(household_id,user_id,role) values($1,$2,'manager'),($1,$3,'member')", [household, owner, child])
      await db.query("insert into household_billing(household_id,subscription_status,paid_through) values($1,'active',now()+interval '1 day')", [household])
      for (let b = 0; b < 2; b++) {
        const routine = randomUUID(), run = randomUUID()
        await db.query("insert into routines(id,household_id,name,type) values($1,$2,'Load routine','one_off')", [routine, household])
        await db.query("insert into routine_occurrences(id,household_id,routine_id,kind,title,scheduled_for) values($1,$2,$3,'routine','Load board',now())", [run, household, routine])
        const rows = Array.from({ length: itemCount }, (_, i) => {
          const id = randomUUID(), measured = i < 12, kind = i % 2 === 0 ? 'activation' : 'expiry'
          if (measured) samples.push({ id, kind, wave: i < 6 ? 1 : 2, offset_ms: (2 + (h * 13 + b * 11 + i * 7) % 53) * 1000 })
          return { id, initially_locked: measured ? kind === 'activation' : i % 2 === 0 }
        })
        const batch = JSON.stringify(rows)
        await db.query(`insert into tasks(id,household_id,routine_id,routine_occurrence_id,assignee_id,title,unlock_at)
          select r.id,$1,$2,$3,$4,'Load item',case when r.initially_locked then now()+interval '2 days' end
          from jsonb_to_recordset($5::jsonb) as r(id uuid,initially_locked boolean)`, [household, routine, run, child, batch])
        await db.query(`insert into occurrence_tasks(occurrence_id,task_id,status)
          select $1,r.id,(case when r.initially_locked then 'locked' else 'unlocked' end)::task_status
          from jsonb_to_recordset($2::jsonb) as r(id uuid,initially_locked boolean)`, [run, batch])
      }
    }
    assert.equal(samples.length, report.fixture.expectedTimedTransitions)
    await db.query(`insert into cyntch_load_cases(task_id,wave,kind,offset_ms)
      select id,wave,kind,offset_ms from jsonb_to_recordset($1::jsonb) as r(id uuid,wave int,kind text,offset_ms int)`, [JSON.stringify(samples)])
    await request('baseline before scheduling')
    const baseline = await db.query(`select count(*)::int as wrong from cyntch_load_cases c join occurrence_tasks s on s.task_id=c.task_id
      where s.status::text <> case when c.kind='activation' then 'locked' else 'unlocked' end`)
    assert.equal(baseline.rows[0].wrong, 0)
    const start = (await db.query("select date_trunc('milliseconds',clock_timestamp()) as at")).rows[0].at
    const monotonicStart = performance.now()
    report.startedAt = start.toISOString()
    await db.query(`update cyntch_load_cases set due_at=$1::timestamptz + ((wave-1)*60000+offset_ms)*interval '1 millisecond'`, [start])
    await db.query(`update tasks t set unlock_at=case when c.kind='activation' then c.due_at else t.unlock_at end,
      expires_at=case when c.kind='expiry' then c.due_at else t.expires_at end from cyntch_load_cases c where c.task_id=t.id`)
    const observe = async () => {
      const result = await db.query(`select c.task_id,c.kind,c.wave,c.due_at,s.status,s.completion_reason,
        clock_timestamp() as observed_at,e.n as events,e.at as event_at
        from cyntch_load_cases c join occurrence_tasks s on s.task_id=c.task_id
        left join lateral (select count(*)::int as n,min(e.occurred_at) as at from native_notification_events e
          where e.household_id=any($1::uuid[]) and e.occurred_at >= $2 and e.subject->>'taskId'=c.task_id::text
          and e.kind=case when c.kind='activation' then 'task_available' else 'task_completed_automatically' end) e on true`, [households, start])
      assert.equal(result.rows.length, samples.length)
      for (const row of result.rows) {
        const expected = row.kind === 'activation' ? 'unlocked' : 'completed'
        if (row.status !== expected) { assert.equal(row.events, 0, 'An uncommitted transition must not have an event'); continue }
        if (row.kind === 'expiry') assert.equal(row.completion_reason, 'expiry')
        assert.equal(row.events, 1, 'Each accepted timed transition needs exactly one durable event')
        const eventLag = row.event_at.getTime() - row.due_at.getTime()
        const observedLag = row.observed_at.getTime() - row.due_at.getTime()
        assert.ok(eventLag >= 0 && observedLag >= eventLag, 'The scheduler must not transition early')
        if (!observed.has(row.task_id)) observed.set(row.task_id, { kind: row.kind, wave: row.wave, eventLag, observedLag })
      }
      return result.rows
    }
    for (let wave = 1; wave <= 2; wave++) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, monotonicStart + wave * 60_000 - performance.now())))
      await request(`minute ${wave}`)
      const rows = await observe()
      assert.equal(rows.filter(row => row.wave <= wave && !observed.has(row.task_id)).length, 0, 'An entire interval elapsed without applying a scheduled transition')
    }
    await request('immediate duplicate tick'); await observe()
    assert.equal(observed.size, samples.length)
    const values = [...observed.values()]
    report.latencyMs = {}
    for (const group of ['all', 'activation', 'expiry']) {
      const subset = group === 'all' ? values : values.filter(value => value.kind === group)
      report.latencyMs[group] = { durableEventRecorded: summarize(subset.map(s => s.eventLag)),
        committedStateObservedUpperBound: summarize(subset.map(s => s.observedLag)) }
    }
    report.method = 'Nearest-rank percentiles. Due times distributed 2–54s after the preceding tick. Durable event time is recorded inside the transaction; the first separate post-response read is a conservative upper bound on commit latency.'
    report.duplicates = 0
    for (const summary of Object.values(report.latencyMs)) assert.ok(summary.committedStateObservedUpperBound.p95 <= report.targetMs, `Controlled p95 exceeded 90s; see ${evidencePath}`)
    report.verified = true
    return report
  } finally { save() }
}
