/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the private operator CLI against a disposable local schema. */
const { test } = require('node:test'), assert = require('node:assert/strict')
const { execFile } = require('node:child_process'), { promisify } = require('node:util')
const { randomUUID } = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { fixture, connectionString } = require('./helpers/account-deletion.cjs')
const run = promisify(execFile), root = path.resolve(__dirname, '..')

test('operator CLI requires explicit access and preserves private content through revision-guarded review', { skip: !connectionString }, async t => {
  const f = await fixture(t)
  const schema = (await f.db.query('select current_schema() as name')).rows[0].name
  assert.match(schema, /^deletion_[a-f0-9]{32}$/)
  const url = new URL(connectionString)
  url.searchParams.set('options', '-c search_path=' + schema)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-review-cli-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const noteFile = path.join(directory, 'private-note.txt')
  const note = 'PRIVATE_REVIEW_NOTE: synthetic fixture only, no actual moderation action claimed.'
  fs.writeFileSync(noteFile, note)
  const id = randomUUID(), subject = 'PRIVATE_SUBJECT', message = 'PRIVATE_MESSAGE with newline\nand escape\u001b[31m text.'
  await f.db.query(`insert into safety_reports(id,reporter_id,household_id,kind,subject,message,request_hash)
    values($1,$2,$3,'content',$4,$5,$6)`, [id, f.owner, f.deleting, subject, message, 'c'.repeat(64)])
  async function command(args, overrides = {}) {
    try {
      const result = await run(process.execPath, [path.join(root, 'scripts/review-safety-reports.cjs'), ...args], {
        cwd: root, timeout: 20000, windowsHide: true,
        env: { ...process.env, SAFETY_REVIEW_DATABASE_URL: url.href, SAFETY_REVIEWER_ID: 'fixture_operator', ...overrides },
      })
      return { ...result, status: 0 }
    } catch (error) {
      assert.equal(typeof error.code, 'number', 'The CLI must exit, not hang or fail to launch')
      return { stdout: error.stdout, stderr: error.stderr, status: error.code }
    }
  }
  const noAccess = await command(['list'], { SAFETY_REVIEW_DATABASE_URL: '', POSTGRES_URL: url.href })
  assert.equal(noAccess.status, 1, 'Application database settings must not implicitly grant operator access')
  assert.equal(noAccess.stdout, '')
  assert.doesNotMatch(noAccess.stderr, /postgresql|search_path|PRIVATE_/)

  const list = await command(['list'])
  assert.equal(list.status, 0)
  assert.equal(JSON.parse(list.stdout)[0].id, id)
  assert.doesNotMatch(list.stdout, /PRIVATE_|reporter_id|household_id|resolution_note/)
  const show = await command(['show', id])
  assert.equal(show.status, 0)
  assert.equal(JSON.parse(show.stdout).message, message)
  assert.ok(!show.stdout.includes('\u001b'), 'User text cannot emit terminal escape bytes')

  for (const [args, overrides] of [
    [['show', 'invalid-id'], {}],
    [['reviewing', id, '1', noteFile], { SAFETY_REVIEWER_ID: '' }],
    [['reviewing', id, '1', path.join(directory, 'missing-note')], {}],
    [['reviewing', id, '0', noteFile], {}],
  ]) {
    const failed = await command(args, overrides)
    assert.equal(failed.status, 1)
    assert.equal(failed.stdout, '')
    assert.doesNotMatch(failed.stderr, /PRIVATE_|postgresql|fixture_operator/)
  }
  assert.equal((await f.db.query('select revision from safety_reports where id=$1', [id])).rows[0].revision, 1)

  const results = await Promise.all([command(['reviewing', id, '1', noteFile]), command(['reviewing', id, '1', noteFile])])
  assert.deepEqual(results.map(result => result.status).sort(), [0, 1], 'Concurrent operators cannot overwrite a review')
  for (const result of results) assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_/)
  const resolved = await command(['resolved', id, '2', noteFile])
  assert.equal(resolved.status, 0)
  assert.equal(JSON.parse(resolved.stdout).revision, 3)
  assert.deepEqual(JSON.parse((await command(['list'])).stdout), [])
  assert.equal((await command(['redacted', id, '3'])).status, 1, 'The CLI enforces the retention interval')
  await f.db.query("update safety_reports set resolved_at=now()-interval '91 days' where id=$1", [id])
  const redacted = await command(['redacted', id, '3'])
  assert.equal(redacted.status, 0)
  const receipt = JSON.parse((await command(['show', id])).stdout)
  assert.equal(receipt.revision, 4)
  for (const field of ['subject', 'message', 'resolution_note']) assert.equal(receipt[field], null)
  const audit = (await f.db.query('select reviewer,action,revision from safety_report_reviews where report_id=$1 order by revision', [id])).rows
  assert.deepEqual(audit, ['reviewing', 'resolved', 'redacted'].map((action, i) => ({ reviewer: 'fixture_operator', action, revision: i + 2 })))
  assert.equal((await command(['reviewing', id, '4', noteFile])).status, 1, 'Redacted text cannot be reopened')
})
