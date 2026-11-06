// Inspect the exact EAS-signed preview, without building or running it.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const expected = require('../fixtures/android-preview.json')
const [apkInput, outputInput, buildTools, readelf, unzip = 'unzip'] = process.argv.slice(2)
if (!apkInput || !outputInput || !buildTools || !readelf) throw Error('Expected APK, evidence directory, build-tools directory and readelf.')
const apk = path.resolve(apkInput), output = path.resolve(outputInput)
fs.mkdirSync(output, { recursive: true })
const run = (file, args, encoding = 'utf8') => execFileSync(file, args, { encoding, timeout: 60000, maxBuffer: 48 * 1024 * 1024 })
const executable = name => path.join(buildTools, name + (process.platform === 'win32' ? '.exe' : ''))
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
const report = { buildId: expected.buildId, appSource: expected.source, checkedAt: new Date().toISOString(),
  scope: 'Signed preview artifact only; no installation, provider delivery or store-release claim.', passed: false }
try {
  report.sha256 = createHash('sha256').update(fs.readFileSync(apk)).digest('hex')
  if (report.sha256 !== expected.sha256) throw Error('APK digest differs from the inspected EAS artifact.')
  const signature = run(java, ['-jar', path.join(buildTools, 'lib', 'apksigner.jar'), 'verify', '--verbose', '--print-certs', apk])
  fs.writeFileSync(path.join(output, 'signature.txt'), signature)
  const signers = [...signature.matchAll(/certificate SHA-256 digest: ([a-f0-9]{64})/g)].map(match => match[1])
  if (!/Number of signers: 1\b/.test(signature) || signers.length !== 1 || signers[0] !== expected.signerSha256) throw Error('Unexpected APK signing identity.')
  report.signerSha256 = signers[0]
  run(executable('zipalign'), ['-c', '-P', '16', '4', apk])
  report.zip16kAligned = true
  const badging = run(executable('aapt2'), ['dump', 'badging', apk])
  fs.writeFileSync(path.join(output, 'badging.txt'), badging)
  if (!/^package: name='com\.cyntch\.app' versionCode='1' versionName='1\.0\.0'/m.test(badging)
    || !/^(?:minSdkVersion|sdkVersion):'24'$/m.test(badging) || !/^targetSdkVersion:'36'$/m.test(badging)
    || !/^uses-permission: name='android\.permission\.POST_NOTIFICATIONS'/m.test(badging)
    || !/^launchable-activity: name='com\.cyntch\.app\.MainActivity'/m.test(badging)) throw Error('Unexpected application identity, SDK floor/target, notification permission or entry point.')
  const manifest = run(executable('aapt2'), ['dump', 'xmltree', apk, '--file', 'AndroidManifest.xml'])
  if (/android:debuggable[^\n]*=(?:true|[^\n]*0xffffffff)/.test(manifest)) throw Error('The preview must not be debuggable.')
  if (!manifest.includes('expo.modules.notifications.service.ExpoFirebaseMessagingService')) throw Error('Firebase messaging service is missing.')
  const resources = run(executable('aapt2'), ['dump', 'resources', apk])
  for (const [name, value] of Object.entries({ project_id: expected.firebaseProjectId, gcm_defaultSenderId: expected.firebaseSenderId, google_app_id: expected.firebaseAppId })) {
    const block = new RegExp('resource 0x[0-9a-f]+ string/' + name + '\\s*\\n([^\\n]+)').exec(resources)
    if (!block || !block[1].includes('"' + value + '"')) throw Error('Wrong linked Firebase resource: ' + name)
  }
  const config = JSON.parse(run(unzip, ['-p', apk, 'assets/app.config']))
  if (config.owner !== 'aspyre' || config.slug !== 'cyntch' || config.extra?.eas?.projectId !== expected.expoProjectId) throw Error('Unexpected embedded Expo project.')
  const bundle = run(unzip, ['-p', apk, 'assets/index.android.bundle'], null)
  const includes = value => bundle.includes(Buffer.from(value)) || bundle.includes(Buffer.from(value, 'utf16le'))
  if (!includes(expected.fixtureUrl) || !includes('pk_test_ZW1lcmdpbmctdG9hZC05OC5jbGVyay5hY2NvdW50cy5kZXYk')) throw Error('The bundle does not use the isolated development configuration.')
  report.configuration = { package: 'com.cyntch.app', version: '1.0.0', versionCode: 1, minSdk: 24, targetSdk: 36,
    expoProjectId: expected.expoProjectId, firebaseProjectId: expected.firebaseProjectId, developmentFixture: true }
  report.libraries = []
  const entries = run(unzip, ['-Z1', apk]).trim().split(/\r?\n/)
  for (const [abi, machine] of Object.entries({ 'arm64-v8a': 'AArch64', x86_64: 'Advanced Micro Devices X86-64' })) {
    const libraries = entries.filter(name => name.startsWith('lib/' + abi + '/') && /^lib\/(?:arm64-v8a|x86_64)\/[a-zA-Z0-9_.+-]+\.so$/.test(name))
    if (!libraries.length) throw Error('No native libraries for ' + abi)
    for (const name of libraries) {
      const file = path.join(output, 'library-' + report.libraries.length + '.so')
      fs.writeFileSync(file, run(unzip, ['-p', apk, name], null))
      const header = run(readelf, ['-hW', file]), segments = run(readelf, ['-lW', file])
      if (!header.includes(machine)) throw Error('Unexpected ELF architecture: ' + name)
      const alignments = segments.split(/\r?\n/).filter(line => /^\s*LOAD\s/.test(line)).map(line => line.trim().split(/\s+/).at(-1))
      if (!alignments.length || alignments.some(value => !/^0x[0-9a-f]+$/i.test(value) || Number(value) < 16384)) throw Error('Native library is not 16 KB aligned: ' + name)
      report.libraries.push({ name, alignments })
      // Only remove the temporary file created above inside this evidence folder.
      fs.unlinkSync(file)
    }
  }
  run(process.execPath, [path.join(__dirname, 'android-notification-icon.cjs'), executable('aapt2'), apk, unzip])
  report.notificationIcons = 'Both manifest references and all five density resources verified.'
  report.passed = true
} catch (error) { report.error = error.message; process.exitCode = 1 }
finally {
  fs.writeFileSync(path.join(output, 'artifact.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, sha256: report.sha256, libraries: report.libraries?.length, error: report.error }))
}
