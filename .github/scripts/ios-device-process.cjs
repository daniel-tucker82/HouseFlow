const { spawnSync } = require('node:child_process')

// Maestro can exit on its driver-startup deadline while xcodebuild continues
// bootstrapping. Keep that attempt in its own POSIX process group so it cannot
// overlap the next text-size journey. Never signal the app or another job.
function runIOSUI(command, args, options) {
  if (process.platform === 'win32') throw new Error('iOS UI processes require a POSIX host.')
  const result = spawnSync(command, args, { ...options, detached: true })
  if ((!result.error && result.status === 0) || !Number.isInteger(result.pid) || result.pid <= 1) return result
  result.driverCleanup = { group: result.pid, signalled: false }
  const signal = value => {
    try { process.kill(-result.pid, value); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  try {
    if (signal('SIGTERM')) {
      result.driverCleanup.signalled = true
      const until = Date.now() + 1500
      const pause = new Int32Array(new SharedArrayBuffer(4))
      while (signal(0) && Date.now() < until) Atomics.wait(pause, 0, 0, 50)
      if (signal(0)) {
        signal('SIGKILL')
        result.driverCleanup.forced = true
      }
    }
  } catch (error) {
    result.driverCleanup.error = error.code ?? error.message
  }
  return result
}
module.exports = { runIOSUI }
