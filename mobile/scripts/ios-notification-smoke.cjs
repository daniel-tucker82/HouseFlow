const fs = require('node:fs')
const path = require('node:path')
const { randomInt } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { inspectScreenshotOrientations } = require('./device-screenshot-evidence.cjs')

// Simulates the APNs payload on our own simulator. This verifies authorization
// and OS presentation, never provider credentials, token routing or real APNs.
function runNotificationSmoke({ device, maestro, output }) {
  fs.mkdirSync(output, { recursive: true })
  const result = { permission: false, injected: false, banner: false, notificationCenter: false, passed: false }
  const save = () => fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2))
  function flow(name, variables = []) {
    const folder=path.join(output,name); fs.mkdirSync(folder,{recursive:true})
    const log=fs.openSync(path.join(folder,'maestro.log'),'w')
    try {
      const run=spawnSync(maestro,['--device',device,'test','--format','junit','--output',path.join(folder,'report.xml'),
        '--test-output-dir',folder,'--debug-output',folder,...variables,path.resolve('.maestro-ios-notifications',name+'.yaml')],
      {stdio:['ignore',log,log],timeout:420_000})
      if(run.status!==0 || run.error) throw new Error(`iOS notification ${name} flow failed (${run.error?.code ?? run.status}).`)
    } finally { fs.closeSync(log) }
  }
  try {
    const ocr=path.join(process.env.RUNNER_TEMP,'cyntch-notification-ocr-'+process.pid)
    const arch=process.arch==='arm64'?'arm64':'x86_64'
    execFileSync('xcrun',['--sdk','macosx','swiftc','-target',arch+'-apple-macosx15.0','../.github/scripts/ios-device-alert-text.swift','-o',ocr],{timeout:90_000})
    flow('request'); result.permission=true; save()
    const title='Family update '+randomInt(10000,100000), body='Your household test update is ready'
    const capture = name => {
      const file=path.join(output,name+'.png')
      execFileSync('xcrun',['simctl','io',device,'screenshot',file],{timeout:20_000})
      return file
    }
    const before=capture('before-delivery')
    const payload=path.join(output,'simulated.apns')
    fs.writeFileSync(payload,JSON.stringify({aps:{alert:{title,body},sound:'default'}}))
    execFileSync(process.execPath,[path.resolve('../.github/scripts/ios-device-record-alert.cjs'),device,output,payload],{timeout:80000})
    result.injected=true; save()
    // The recording is closed before opening the pane. The two independent
    // observations should survive a failure in either the UI flow or OCR.
    try {
      flow('center',['-e','ALERT_TITLE='+title,'-e','ALERT_BODY='+body])
      result.notificationCenter=true
    } catch(error) { result.centerError=error.message }
    save()
    try {
      result.bannerFrames=JSON.parse(execFileSync(ocr,[title,before,path.join(output,'delivery.mp4'),output],{encoding:'utf8',timeout:180000}))
      result.banner=result.bannerFrames.length>0
    } catch(error) { result.bannerError=error.message }
    result.screens=inspectScreenshotOrientations(output,{'ios-notifications-system-prompt.png':'portrait',
      'ios-notifications-granted.png':'portrait','ios-notification-center.png':'portrait'},{includeStartup:false})
    if (!result.banner || !result.notificationCenter || !result.screens.passed) throw new Error('Notification banner or system presentation captures are incomplete.')
    result.passed=true
  } catch(error) { result.error=error.message }
  finally { save() }
  return result
}
module.exports={runNotificationSmoke}
