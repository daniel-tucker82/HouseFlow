/* eslint-disable @typescript-eslint/no-require-imports -- Load actual kiosk code against isolated dependencies. */
const path = require('node:path'), Module = require('node:module')
const { buildSync } = require('esbuild')

exports.loadNativeKiosk = function loadNativeKiosk(mocks) {
  const root = path.resolve(__dirname, '../..'), loaded = new Module(__filename, module)
  loaded.require = name => mocks[name] ?? require(name)
  loaded._compile(buildSync({ stdin: { contents: 'export * from "./lib/native-kiosk-guard"; export * from "./lib/native-kiosk-store"', resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, external: Object.keys(mocks) }).outputFiles[0].text, __filename)
  return loaded.exports
}
