// Inspect the actual linked small icon used by both Android notification paths.
const { execFileSync } = require('node:child_process')
const [aapt, apk, unzip = 'unzip'] = process.argv.slice(2)
if (!aapt || !apk) throw Error('Expected aapt2 and a compiled APK.')
const dump = (...args) => execFileSync(aapt, ['dump', ...args], {encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024})
const resources = dump('resources', apk), manifest = dump('xmltree', apk, '--file', 'AndroidManifest.xml')
const entry = /^\s*resource (0x[0-9a-f]+) drawable\/notification_icon\s*\n((?:[ \t]+\([^\n]+\n?)+)/m.exec(resources)
if (!entry) throw Error('The compiled APK has no dedicated notification drawable.')
for (const key of ['com.google.firebase.messaging.default_notification_icon', 'expo.modules.notifications.default_notification_icon']) {
  const matches = manifest.split(/^\s*E: /m).filter(node => node.startsWith('meta-data ') && node.includes('="'+key+'"'))
  if (matches.length !== 1 || !new RegExp(':resource\\([^)]*\\)=@'+entry[1]+'\\b').test(matches[0])) throw Error('Wrong compiled notification icon for '+key)
}
for (const [density,size] of Object.entries({mdpi:24,hdpi:36,xhdpi:48,xxhdpi:72,xxxhdpi:96})) {
  const image = new RegExp('\\('+density+'(?:-v\\d+)?\\) \\(file\\) (\\S+)').exec(entry[2])
  if (!image) throw Error('Missing linked notification icon for '+density)
  const header = execFileSync(unzip,['-p',apk,image[1]],{timeout:15000,maxBuffer:1024*1024}).subarray(0,24)
  if (header.length!==24 || !header.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
    || header.toString('ascii',12,16)!=='IHDR' || header.readUInt32BE(16)!==size || header.readUInt32BE(20)!==size) throw Error('Invalid '+density+' notification PNG.')
}
console.log('Verified both notification manifest references and the five packaged 24–96 px status icons.')
