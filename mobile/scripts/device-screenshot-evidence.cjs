// Check actual pixels, rather than trusting a rotation command's name. Android
// tablets can have a landscape natural orientation, unlike the test phones.
const fs = require('node:fs')
const path = require('node:path')

const required = {
  'welcome-portrait.png': 'portrait',
  'welcome-landscape.png': 'landscape',
  'native-sign-in-portrait.png': 'portrait',
  'native-sign-in-landscape.png': 'landscape',
  'welcome-after-restart.png': 'portrait',
}
function inspectScreenshotOrientations(directory) {
  const screenshots = []
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (required[entry.name]) {
        const bytes = fs.readFileSync(file)
        if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
          || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
          throw new Error(`Expected a PNG screenshot: ${entry.name}`)
        }
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
        const orientation = width > height ? 'landscape' : width < height ? 'portrait' : 'square'
        screenshots.push({ file: path.relative(directory, file), width, height, orientation,
          expected: required[entry.name], passed: orientation === required[entry.name] })
      }
    }
  }
  walk(directory)
  const missing = Object.keys(required).filter(name => !screenshots.some(item => path.basename(item.file) === name))
  return { passed: missing.length === 0 && screenshots.every(item => item.passed), missing, screenshots }
}

function androidOrientationParameters(displaySize) {
  const match = /Physical size:\s*(\d+)x(\d+)/.exec(displaySize)
  if (!match || Number(match[1]) === Number(match[2])) throw new Error('Expected a rectangular Android physical display size.')
  const naturalLandscape = Number(match[1]) > Number(match[2])
  return {
    portrait: naturalLandscape ? 'LANDSCAPE_LEFT' : 'PORTRAIT',
    landscape: naturalLandscape ? 'PORTRAIT' : 'LANDSCAPE_LEFT',
  }
}

module.exports = { inspectScreenshotOrientations, androidOrientationParameters }
