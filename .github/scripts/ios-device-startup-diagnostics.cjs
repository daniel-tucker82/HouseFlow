const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Read-only evidence after setup fails, before deleting the owned simulator.
// Keep setup failed; do not reboot, relaunch, reinstall or alter its deadlines.
function collectStartupDiagnostics(device, folder) {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true'
    || !/^[0-9a-f-]{36}$/i.test(device)) throw new Error('Startup diagnostics require an owned Actions simulator.')
  fs.mkdirSync(folder, { recursive: true })
  const commands = [
    ['host-memory', '/usr/bin/vm_stat', []],
    ['host-capacity', '/usr/sbin/sysctl', ['hw.memsize', 'hw.ncpu', 'vm.loadavg']],
    // Executable names only; never include command-line credentials or environments.
    ['host-processes', '/bin/ps', ['-axo', 'pid,ppid,%cpu,%mem,comm']],
    ['simulator-services', 'xcrun', ['simctl', 'spawn', device, 'log', 'show', '--style', 'compact', '--last', '5m',
      '--predicate', 'process == "SpringBoard" OR process == "runningboardd" OR process == "installd"']],
    ['host-simulator-services', '/usr/bin/log', ['show', '--style', 'compact', '--last', '5m',
      '--predicate', 'subsystem BEGINSWITH "com.apple.CoreSimulator"']],
  ]
  const results = commands.map(([name, command, args]) => {
    const started = Date.now()
    const run = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
    fs.writeFileSync(path.join(folder, name + '.log'), `${run.stdout ?? ''}\n${run.stderr ?? ''}`)
    return { name, exitCode: run.status, error: run.error?.code, elapsedMs: Date.now() - started }
  })
  fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(results, null, 2))
  return results
}
module.exports = { collectStartupDiagnostics }
