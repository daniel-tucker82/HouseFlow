// Record the Home Screen before injecting an alert. simctl push can return
// after a transient banner has already disappeared.
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const run = require('node:util').promisify(execFile)
const delay = require('node:timers/promises').setTimeout

async function record(device, output, payload) {
  const movie = path.join(output, 'delivery.mp4')
  const start = Date.now()
  const timing = {}
  let status, log = ''
  const child = spawn('xcrun', ['simctl', 'io', device, 'recordVideo', '--codec=h264', movie], {stdio:['ignore','pipe','pipe']})
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log = (log + data).slice(-4096) })
  child.once('error', error => { status = {error:error.message} })
  child.once('close', (code, signal) => { status ??= {code,signal} })
  try {
    while (!/recording started/i.test(log) && !(fs.existsSync(movie) && fs.statSync(movie).size > 32)) {
      if (status || Date.now() - start > 20000) throw Error('Simulator screen recorder did not start.')
      await delay(100)
    }
    await delay(1000)
    timing.pushStartedMs = Date.now() - start
    await run('xcrun', ['simctl','push',device,'com.cyntch.app',payload], {timeout:30000})
    timing.pushAcknowledgedMs = Date.now() - start
    await delay(7000)
  } finally {
    if (!status) child.kill('SIGINT')
    const stop = Date.now()
    while (!status && Date.now() - stop < 15000) await delay(100)
    if (!status) child.kill('SIGKILL')
    fs.writeFileSync(path.join(output,'capture-timing.json'), JSON.stringify({...timing, elapsedMs:Date.now()-start, recorder:status ?? 'timed out'}))
    fs.writeFileSync(path.join(output,'recorder.log'),log)
  }
  if (!status || status.error || (![0,130].includes(status.code) && status.signal !== 'SIGINT') || !fs.statSync(movie).size) throw Error('Simulator screen recording did not finish.')
}
record(...process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode=1 })
