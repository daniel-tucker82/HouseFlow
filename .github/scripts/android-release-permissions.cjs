// Inspect the merged APK, not just Expo config: dependency manifests can add
// permissions that the app itself never requests or needs.
const { execFileSync } = require('node:child_process')
const [aapt, apk] = process.argv.slice(2)
if (!aapt || !apk) throw Error('Expected aapt2 and the compiled release APK.')
const badging = execFileSync(aapt, ['dump', 'badging', apk], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
const permissions = new Set([...badging.matchAll(/^uses-permission(?:-sdk-\d+)?: name='([^']+)'/gm)].map(match => match[1]))
for (const permission of ['READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW']) {
  if (permissions.has('android.permission.' + permission)) throw Error('Unneeded release permission remains: ' + permission)
}
for (const permission of ['android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS',
  'android.permission.USE_BIOMETRIC', 'android.permission.VIBRATE', 'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.RECEIVE_BOOT_COMPLETED', 'android.permission.WAKE_LOCK', 'com.android.vending.BILLING']) {
  if (!permissions.has(permission)) throw Error('Required capability permission is missing: ' + permission)
}
console.log('Verified no shared-storage/overlay permissions; notification, kiosk authentication, background work and billing permissions retained.')
