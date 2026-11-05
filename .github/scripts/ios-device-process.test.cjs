const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const vm = require('node:vm')
const { runIOSUI } = require('./ios-device-process.cjs')

test('cleanup targets only the failed attempt group and preserves failure', () => {
  const result = { pid: 45123, status: 1 }, calls = []
  let alive = true
  const sandbox = { module: { exports: {} }, require: name => {
    assert.equal(name, 'node:child_process')
    return { spawnSync: (_command, _args, options) => { assert.equal(options.detached, true); return result } }
  }, process: { platform: 'darwin', kill: (pid, signal) => {
    calls.push([pid, signal])
    if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    alive = false
    return true
  } } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'ios-device-process.cjs'), 'utf8'), sandbox)
  const run = sandbox.module.exports.runIOSUI('maestro', [], { timeout: 1000 })
  assert.equal(run, result)
  assert.equal(run.status, 1)
  assert.equal(run.driverCleanup.signalled, true)
  assert.ok(calls.every(([pid]) => pid === -45123))
  assert.equal(calls[0][1], 'SIGTERM')
})

test('failed UI attempt terminates its surviving child without signalling another group', { skip: process.platform === 'win32' }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cyntch-ui-process-'))
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  let group
  try {
    const childFile = path.join(folder, 'child.cjs')
    const parentFile = path.join(folder, 'parent.cjs')
    fs.writeFileSync(childFile, `const fs=require('node:fs'),path=require('node:path');
process.on('SIGTERM',()=>{fs.writeFileSync(path.join(__dirname,'stopped'),'yes');process.exit(0)});
fs.writeFileSync(path.join(__dirname,'ready'),'yes');setInterval(()=>{},1000);`)
    fs.writeFileSync(parentFile, `const fs=require('node:fs'),path=require('node:path');
const child=require('node:child_process').spawn(process.execPath,[path.join(__dirname,'child.cjs')],{stdio:'ignore'});child.unref();
const check=setInterval(()=>{if(fs.existsSync(path.join(__dirname,'ready'))){clearInterval(check);process.exit(1)}},10);`)
    const result = runIOSUI(process.execPath, [parentFile], { timeout: 5000, stdio: 'ignore' })
    group = result.pid
    assert.equal(result.status, 1, 'cleanup must not turn failure into success')
    assert.equal(result.driverCleanup?.signalled, true)
    assert.equal(result.driverCleanup?.error, undefined)
    assert.equal(fs.readFileSync(path.join(folder, 'stopped'), 'utf8'), 'yes')
    assert.equal(process.kill(other.pid, 0), true, 'unrelated process remains alive')
  } finally {
    if (group > 1) { try { process.kill(-group, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }
    other.kill('SIGKILL')
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(folder).startsWith('cyntch-ui-process-'))
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('successful and unstarted commands retain their original status', { skip: process.platform === 'win32' }, () => {
  const passed = runIOSUI(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  assert.equal(passed.status, 0)
  assert.equal(passed.driverCleanup, undefined)
  const missing = runIOSUI(path.join(os.tmpdir(), 'cyntch-no-such-ui-executable'), [], { stdio: 'ignore' })
  assert.equal(missing.error.code, 'ENOENT')
  assert.equal(missing.driverCleanup, undefined)
})
