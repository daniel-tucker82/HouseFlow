// Rehearse the pending mobile schema on a new local database. Never opens an existing application DB.
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { Client } = require("pg")

const root = path.resolve(__dirname, "..")
const published = "6c1a5de" // public-policy release, before mobile API rollout
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })
const digest = value => crypto.createHash("sha256").update(value).digest("hex")
const ident = value => '"' + value.replaceAll('"', '""') + '"'
const tableColumns = async client => (await client.query(`select c.table_name, array_agg(c.column_name::text order by c.ordinal_position) as columns
  from information_schema.columns c join information_schema.tables t using(table_catalog, table_schema, table_name)
  where c.table_schema = 'public' and t.table_type = 'BASE TABLE' group by c.table_name order by c.table_name`)).rows

async function snapshot(client, tables) {
  const out = {}
  for (const { table_name: name, columns } of tables) {
    const { rows } = await client.query(`select row_to_json(r)::text as row from (select ${columns.map(ident).join(",")} from public.${ident(name)}) r order by row_to_json(r)::text collate "C"`)
    out[name] = { rows: rows.length, hash: digest(JSON.stringify(rows.map(r => r.row))) }
  }
  return out
}

async function main() {
  const adminUrl = new URL(process.env.CYNTCH_REHEARSAL_ADMIN_URL || "invalid:missing")
  assert(adminUrl.protocol === "postgresql:" && ["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname) &&
    adminUrl.pathname === "/postgres" && !adminUrl.search && !adminUrl.hash, "Set CYNTCH_REHEARSAL_ADMIN_URL to an explicit local PostgreSQL /postgres URL without options")
  const dbName = "cyntch_mobile_rehearsal_" + crypto.randomUUID().replaceAll("-", "")
  const testUrl = new URL(adminUrl); testUrl.pathname = "/" + dbName
  const old = git("ls-tree", "--name-only", published, "database/").trim().split(/\r?\n/).filter(n => n.endsWith(".sql")).sort()
  const all = fs.readdirSync(path.join(root, "database")).filter(n => n.endsWith(".sql")).sort().map(n => "database/" + n)
  assert(old.length && all.length > old.length)
  assert.deepEqual(all.slice(0, old.length), old, "Baseline migrations no longer form the same ordered prefix")
  for (const file of old) assert.equal(fs.readFileSync(path.join(root, file), "utf8").replaceAll("\r\n", "\n"), git("show", published + ":" + file).replaceAll("\r\n", "\n"), "Changed legacy migration: " + file)
  const admin = new Client({ connectionString: adminUrl.href }), db = new Client({ connectionString: testUrl.href })
  await admin.connect()
  let completed = false
  try {
    await admin.query(`create database ${ident(dbName)} template template0`)
    console.log("Created fresh local rehearsal database:", dbName)
    await db.connect()
    assert.equal((await db.query("select current_database() as name")).rows[0].name, dbName)
    const apply = async files => { for (const file of files) {
      try { await db.query(fs.readFileSync(path.join(root, file), "utf8")) }
      catch (err) { throw new Error(file + ": " + err.message) }
    }}
    await apply(old)
    const hh = crypto.randomUUID()
    await db.query("insert into users(id,full_name) values('rehearsal-parent','Rehearsal parent')")
    await db.query("insert into households(id,name,leader_id) values($1,'Rehearsal household','rehearsal-parent')", [hh])
    await db.query("insert into household_members(household_id,user_id,role) values($1,'rehearsal-parent','manager')", [hh])
    execFileSync(process.execPath, ["scripts/seed-weekly-kids-chores.cjs"], { cwd: root, env: { ...process.env,
      POSTGRES_URL: testUrl.href, SEED_HOUSEHOLD_ID: hh, SEED_CHILD_NAMES: "Ava,Ben,Mia" }, stdio: ["ignore","pipe","pipe"] })
    // Old join notifications had an actor but no subject. Old departure alerts
    // sometimes retained a name without any account ID that could identify it.
    // The migration intentionally adjusts those records; check the exact edits.
    const joined = crypto.randomUUID(), left = crypto.randomUUID()
    await db.query(`insert into notification_events(id,household_id,kind,actor_user_id,metadata) values
      ($1,$3,'member_joined_via_link','rehearsal-parent','{"memberName":"Rehearsal parent"}'),
      ($2,$3,'member_left_household',null,'{"memberName":"Past member","reason":"left"}')`, [joined, left, hh])
    await db.query(`insert into user_notifications(event_id,user_id,title,body) values
      ($1,'rehearsal-parent','Joined','A member joined.'),($2,'rehearsal-parent','Departure','Past member left.')`, [joined, left])
    const originalColumns = await tableColumns(db), before = await snapshot(db, originalColumns)
    assert(before.occurrence_tasks.rows > 0 && before.household_members.rows === 4)
    // Build the expected fingerprint for every original column and row, then
    // roll these three edits back so the actual upgrade runs on legacy data.
    await db.query("begin")
    await db.query("update notification_events set subject_member_user_id='rehearsal-parent' where id=$1", [joined])
    await db.query(`update notification_events set metadata='{"reason":"left"}' where id=$1`, [left])
    await db.query("update user_notifications set body='Household membership changed.' where event_id=$1", [left])
    const expected = await snapshot(db, originalColumns)
    await db.query("rollback")
    await apply(all)
    const after = await snapshot(db, originalColumns)
    assert.deepEqual(after, expected, "Migration changed legacy data outside the expected notification backfills")
    const { rows: [versions] } = await db.query("select count(*)::int n,count(distinct status_version)::int versioned from occurrence_tasks")
    assert.equal(versions.versioned, versions.n)
    const upgradedColumns = await tableColumns(db), first = await snapshot(db, upgradedColumns)
    await apply(all)
    assert.deepEqual(await snapshot(db, upgradedColumns), first, "Reapplying the migration set changed fixture data")
    console.log(JSON.stringify({baseline: published, legacyMigrations: old.length, pendingMigrations: all.length-old.length,
      legacyTables: originalColumns.length, upgradedTables: upgradedColumns.length, originalRows: Object.values(before).reduce((n,t)=>n+t.rows,0),
      originalFingerprint: digest(JSON.stringify(before)), upgradedFingerprint: digest(JSON.stringify(first)),
      versionedOccurrenceTasks: versions.n, expectedNotificationFieldChanges: 3, matchedExpectedLegacyData: true, replayPreservedRows: true}))
    completed = true
  } finally {
    await db.end().catch(() => {})
    try { if (completed) await admin.query(`drop database ${ident(dbName)}`) } finally { await admin.end() }
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1 })
