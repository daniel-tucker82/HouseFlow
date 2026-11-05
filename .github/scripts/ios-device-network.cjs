// Only the disposable GitHub-hosted macOS VM may lose networking. The simulator
// shares that network; loopback remains available for Maestro/XCTest. A separate
// process restores the interface even if the UI runner is killed or hangs.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', timeout: 10000 }).trim()
function requireOwnedHost(env = process.env, platform = process.platform) {
  if (platform !== 'darwin' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    env.CYNTCH_IOS_REPLAY_SCOPE !== 'offline' || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '')) {
    throw new Error('Network interruption is restricted to an explicit offline check on a disposable hosted macOS runner.')
  }
}
function networkInterface(route, configuration) {
  const name = /^\s*interface:\s*(en[0-9]+)\s*$/m.exec(route)?.[1]
  const flags = configuration.split('\n')[0]
  if (!name || !flags.startsWith(name + ':') || !/<[^>]*\bUP\b[^>]*>/.test(flags) ||
    !/<[^>]*\bRUNNING\b[^>]*>/.test(flags)) throw new Error('A running Ethernet interface on the default route is required.')
  return name
}
function isUp(name) { return /<[^>]*\bUP\b[^>]*>/.test(command('/sbin/ifconfig', [name]).split('\n')[0]) }
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
function restoreDecision({ requested, ownerAlive, now, until }) {
  return requested ? 'requested' : !ownerAlive ? 'owner-exited' : now >= until ? 'deadline' : null
}
function watchdog(folder) {
  requireOwnedHost()
  const config = JSON.parse(fs.readFileSync(path.join(folder, 'config.json'), 'utf8'))
  if (!/^en[0-9]+$/.test(config.interface) || config.runId !== process.env.GITHUB_RUN_ID ||
    !Number.isInteger(config.ownerPid) || config.ownerPid <= 1 ||
    config.until <= Date.now() || config.until - Date.now() > 240000) throw new Error('Invalid bounded network restoration request.')
  fs.writeFileSync(path.join(folder, 'ready'), String(process.pid))
  let reason
  while (!(reason = restoreDecision({ requested: fs.existsSync(path.join(folder, 'restore')), ownerAlive: alive(config.ownerPid), now: Date.now(), until: config.until }))) wait(250)
  const result = { reason, restored: false, at: new Date().toISOString() }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      command('sudo', ['-n', '/sbin/ifconfig', config.interface, 'up'])
      if (!isUp(config.interface)) throw new Error('Interface did not return up.')
      result.restored = true; break
    } catch (error) { result.error = error.message; wait(1000) }
  }
  fs.writeFileSync(path.join(folder, 'restored.json'), JSON.stringify(result, null, 2))
  if (!result.restored) process.exitCode = 1
}
function disconnect(folder) {
  requireOwnedHost()
  if (fs.existsSync(folder)) throw new Error('Network interruption state cannot be reused.')
  command('sudo', ['-n', 'true'])
  const route = command('/sbin/route', ['-n', 'get', 'default'])
  const candidate = /^\s*interface:\s*(en[0-9]+)\s*$/m.exec(route)?.[1]
  if (!candidate) throw new Error('Default route is not an owned Ethernet interface.')
  const before = command('/sbin/ifconfig', [candidate])
  const name = networkInterface(route, before)
  fs.mkdirSync(folder, { recursive: true })
  const config = { runId: process.env.GITHUB_RUN_ID, interface: name, ownerPid: process.pid, until: Date.now() + 240000, before, route }
  fs.writeFileSync(path.join(folder, 'config.json'), JSON.stringify(config, null, 2))
  const log = fs.openSync(path.join(folder, 'watchdog.log'), 'w')
  const child = spawn(process.execPath, [__filename, '--watchdog', folder], { detached: true, stdio: ['ignore', log, log], env: process.env })
  child.on('error', () => {})
  child.unref(); fs.closeSync(log)
  const deadline = Date.now() + 10000
  while (!fs.existsSync(path.join(folder, 'ready')) && Date.now() < deadline) wait(100)
  if (!child.pid || !alive(child.pid) || !fs.existsSync(path.join(folder, 'ready'))) throw new Error('Independent network restoration did not start.')
  try {
    command('sudo', ['-n', '/sbin/ifconfig', name, 'down'])
    if (isUp(name)) throw new Error('Host interface did not go down.')
    fs.writeFileSync(path.join(folder, 'disconnected.json'), JSON.stringify({ at: new Date().toISOString(), interface: name, watchdogPid: child.pid }))
  } catch (error) { restore(folder); throw error }
  return config
}
function restore(folder) {
  requireOwnedHost()
  fs.writeFileSync(path.join(folder, 'restore'), '')
  const resultPath = path.join(folder, 'restored.json'), deadline = Date.now() + 45000
  while (!fs.existsSync(resultPath) && Date.now() < deadline) wait(100)
  if (!fs.existsSync(resultPath)) {
    // If the child itself failed, the still-running parent also restores the
    // exact saved interface. This is a test failure, never successful evidence.
    const config = JSON.parse(fs.readFileSync(path.join(folder, 'config.json'), 'utf8'))
    if (!/^en[0-9]+$/.test(config.interface) || config.runId !== process.env.GITHUB_RUN_ID) throw new Error('Invalid network recovery state.')
    command('sudo', ['-n', '/sbin/ifconfig', config.interface, 'up'])
    const fallback = { reason: 'watchdog-unavailable', restored: isUp(config.interface), at: new Date().toISOString() }
    fs.writeFileSync(resultPath, JSON.stringify(fallback, null, 2))
  }
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  if (!result.restored) throw new Error('Host network recovery failed.')
  return result
}
function assertUnavailable(origin) {
  const probe = spawnSync('/usr/bin/curl', ['--silent', '--show-error', '--connect-timeout', '3', '--max-time', '5', '--output', '/dev/null', origin], { encoding: 'utf8', timeout: 7000 })
  if (probe.error || ![6,7,28,35].includes(probe.status)) throw new Error('The isolated backend is still reachable or the network probe failed unexpectedly.')
  return { exitCode: probe.status, checkedAt: new Date().toISOString() }
}
if (require.main === module) {
  if (process.argv[2] !== '--watchdog' || !process.argv[3]) throw new Error('Only the bounded restoration child is executable.')
  watchdog(path.resolve(process.argv[3]))
}
module.exports = { requireOwnedHost, networkInterface, restoreDecision, disconnect, restore, assertUnavailable }
