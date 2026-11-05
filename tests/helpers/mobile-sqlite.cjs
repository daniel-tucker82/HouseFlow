/* eslint-disable @typescript-eslint/no-require-imports -- Native storage contract backed by actual SQLite in Node. */
const { DatabaseSync } = require('node:sqlite')
class SqliteAdapter {
  constructor(filename) { this.database = new DatabaseSync(filename); this.tail = Promise.resolve(); this.failOnBoardWrite = false }
  async execAsync(sql) { this.database.exec(sql) }
  async runAsync(sql, ...values) {
    if (this.failOnBoardWrite && sql.includes('INSERT INTO board_snapshots')) throw new Error('Simulated disk write failure')
    return this.database.prepare(sql).run(...values)
  }
  async getFirstAsync(sql, ...values) { return this.database.prepare(sql).get(...values) ?? null }
  async getAllAsync(sql, ...values) { return this.database.prepare(sql).all(...values) }
  async withExclusiveTransactionAsync(work) {
    const run = this.tail.then(async () => {
      this.database.exec('BEGIN IMMEDIATE')
      try { await work(this); this.database.exec('COMMIT') }
      catch (error) { this.database.exec('ROLLBACK'); throw error }
    })
    this.tail = run.catch(() => {})
    return run
  }
  close() { this.database.close() }
}
module.exports = { SqliteAdapter }
