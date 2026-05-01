/**
 * Apply all database/*.sql files in sorted order to the target Postgres instance.
 *
 * Connection string resolution (first match wins):
 * 1. MIGRATE_DATABASE_URL
 * 2. DATABASE_PUBLIC_URL
 * 3. POSTGRES_URL if it does not look like local dev
 * 4. A line in .env.local like: # DATABASE_PUBLIC_URL=postgresql://...
 */

const fs = require("fs")
const path = require("path")
const pg = require("pg")

const root = path.join(__dirname, "..")

function loadRailwayUrlFromEnvLocal() {
  const envPath = path.join(root, ".env.local")
  if (!fs.existsSync(envPath)) return null
  const text = fs.readFileSync(envPath, "utf8")
  const match = text.match(/^\s*#\s*DATABASE_PUBLIC_URL=(.+)$/m)
  if (!match) return null
  return match[1].trim().replace(/^["']|["']$/g, "")
}

function resolveConnectionString() {
  const a = process.env.MIGRATE_DATABASE_URL?.trim()
  if (a) return a
  const b = process.env.DATABASE_PUBLIC_URL?.trim()
  if (b) return b
  const c = process.env.POSTGRES_URL?.trim()
  if (c && !/localhost|127\.0\.0\.1/.test(c)) return c
  const fromComments = loadRailwayUrlFromEnvLocal()
  if (fromComments) return fromComments
  throw new Error(
    "No database URL: set MIGRATE_DATABASE_URL or DATABASE_PUBLIC_URL, or add a commented DATABASE_PUBLIC_URL line in .env.local (see script header).",
  )
}

function sslOption(connectionString) {
  if (connectionString.includes("localhost") || connectionString.includes("127.0.0.1")) {
    return undefined
  }
  return { rejectUnauthorized: false }
}

async function main() {
  const connectionString = resolveConnectionString()
  const client = new pg.Client({
    connectionString,
    ssl: sslOption(connectionString),
  })
  await client.connect()

  const dir = path.join(root, "database")
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()

  for (const file of files) {
    const full = path.join(dir, file)
    const sql = fs.readFileSync(full, "utf8")
    process.stdout.write(`→ ${file} … `)
    await client.query(sql)
    process.stdout.write("ok\n")
  }

  await client.end()
  process.stdout.write(`Applied ${files.length} migration file(s).\n`)
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`)
  process.exit(1)
})
