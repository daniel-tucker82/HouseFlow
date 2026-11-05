const test = require('node:test'), assert = require('node:assert/strict')
const { ownedAppExecutable } = require('./ios-device-app.cjs')
const device = '5F61B6FE-842D-407E-8632-8DA61327F897'
const dataPath = `/Users/runner/Library/Developer/CoreSimulator/Devices/${device}/data`
const installed = dataPath + '/Containers/Bundle/Application/C24B9D9A-CE99-4F72-8B15-D3DDCD7700C8/'
const identity = { device, dataPath, identifier: 'com.cyntch.app', executable: 'Cyntch' }

test('original and observed Maestro-reinstalled bundle keep the same owned executable', () => {
  for (const name of ['Cyntch.app', 'com.cyntch.app-1793896836371.app']) {
    const bundle = installed + name
    assert.equal(ownedAppExecutable({ ...identity, bundle }), bundle + '/Cyntch')
  }
})

test('ownership check rejects other apps, devices, identifiers and escaping paths', () => {
  const bundle = installed + 'com.cyntch.app-1793896836371.app'
  for (const override of [
    { device: '6F61B6FE-842D-407E-8632-8DA61327F897' }, { device: '../' },
    { dataPath: '/tmp/data' }, { identifier: 'com.example.app' },
    { executable: '../Other' }, { executable: 'Other' },
    { bundle: bundle.replace(device, '6F61B6FE-842D-407E-8632-8DA61327F897') },
    { bundle: installed + 'Other.app' }, { bundle: installed + 'com.cyntch.app-anything.app' },
    { bundle: installed + '../Cyntch.app' }, { bundle: installed + 'Cyntch.app/../Cyntch.app' },
    { bundle: '/tmp' + bundle }, { bundle: bundle + '/Nested.app' },
  ]) assert.throws(() => ownedAppExecutable({ ...identity, bundle, ...override }))
})
