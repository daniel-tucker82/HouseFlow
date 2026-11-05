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
    execFileSync('xcrun',['--sdk','macosx','swiftc','../.github/scripts/ios-device-alert-text.swift','-o',ocr],{timeout:90_000})
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
    execFileSync('xcrun',['simctl','push',device,'com.cyntch.app',payload],{timeout:30_000})
    result.injected=true; save()
    const shots=[],start=Date.now()
    for(let n=1;n<=5 && Date.now()-start<8000;n++){
      shots.push(capture('banner-'+n))
      if(n<5) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,350)
    }
    result.bannerFrames=JSON.parse(execFileSync(ocr,[title,before,...shots],{encoding:'utf8',timeout:90_000}))
    result.banner=result.bannerFrames.length>0; save()
    flow('center',['-e','ALERT_TITLE='+title,'-e','ALERT_BODY='+body])
    result.notificationCenter=true
    result.screens=inspectScreenshotOrientations(output,{'ios-notifications-system-prompt.png':'portrait',
      'ios-notifications-granted.png':'portrait','ios-notification-center.png':'portrait'},{includeStartup:false})
    if (!result.banner || !result.screens.passed) throw new Error('Notification banner or system presentation captures are incomplete.')
    result.passed=true
  } catch(error) { result.error=error.message }
  finally { save() }
  return result
}
module.exports={runNotificationSmoke}
