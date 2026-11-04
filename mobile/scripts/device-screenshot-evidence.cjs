// Check captured image geometry, rather than trusting a rotation command's name.
// XCTest PNGs can retain portrait pixel storage with an EXIF display rotation.
const fs = require('node:fs')
const path = require('node:path')

const required = {
  'welcome-portrait.png': 'portrait',
  'welcome-landscape.png': 'landscape',
  'native-sign-in-portrait.png': 'portrait',
  'native-sign-in-landscape.png': 'landscape',
  'welcome-after-restart.png': 'portrait',
}

function exifOrientation(bytes) {
  const order = bytes.toString('ascii', 0, 2)
  if (bytes.length < 8 || !['II', 'MM'].includes(order)) throw new Error('Invalid screenshot EXIF header.')
  const read16 = offset => order === 'II' ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset)
  const read32 = offset => order === 'II' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
  if (read16(2) !== 42) throw new Error('Invalid screenshot EXIF TIFF marker.')
  const offset = read32(4)
  if (offset < 8 || offset + 2 > bytes.length) throw new Error('Invalid screenshot EXIF directory offset.')
  const count = read16(offset)
  if (offset + 2 + count * 12 + 4 > bytes.length) throw new Error('Truncated screenshot EXIF directory.')
  let orientation
  for (let index = 0; index < count; index++) {
    const entry = offset + 2 + index * 12
    if (read16(entry) !== 0x0112) continue
    if (orientation !== undefined || read16(entry + 2) !== 3 || read32(entry + 4) !== 1) {
      throw new Error('Invalid screenshot EXIF orientation entry.')
    }
    orientation = read16(entry + 8)
    if (orientation < 1 || orientation > 8) throw new Error('Invalid screenshot EXIF orientation value.')
  }
  return orientation ?? 1
}

function screenshotDimensions(bytes) {
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Expected a PNG screenshot.')
  }
  const pixelWidth = bytes.readUInt32BE(16), pixelHeight = bytes.readUInt32BE(20)
  if (!pixelWidth || !pixelHeight) throw new Error('Invalid screenshot dimensions.')
  let orientation = 1, foundExif = false, foundEnd = false
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('Truncated screenshot PNG chunk.')
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length
    if (end > bytes.length) throw new Error('Truncated screenshot PNG chunk data.')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'eXIf') {
      if (foundExif) throw new Error('Multiple screenshot EXIF chunks.')
      foundExif = true
      orientation = exifOrientation(bytes.subarray(offset + 8, end - 4))
    }
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length) throw new Error('Invalid screenshot PNG end.')
      foundEnd = true
      break
    }
    offset = end
  }
  if (!foundEnd) throw new Error('Screenshot PNG has no end chunk.')
  const swapsAxes = orientation >= 5
  return { pixelWidth, pixelHeight, exifOrientation: orientation,
    width: swapsAxes ? pixelHeight : pixelWidth, height: swapsAxes ? pixelWidth : pixelHeight }
}

function inspectScreenshotOrientations(directory, additionalRequired = {}) {
  const expected = { ...required, ...additionalRequired }
  const screenshots = []
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (expected[entry.name]) {
        const bytes = fs.readFileSync(file)
        const dimensions = screenshotDimensions(bytes)
        const { width, height } = dimensions
        const orientation = width > height ? 'landscape' : width < height ? 'portrait' : 'square'
        screenshots.push({ file: path.relative(directory, file), ...dimensions, orientation,
          expected: expected[entry.name], passed: orientation === expected[entry.name] })
      }
    }
  }
  walk(directory)
  const missing = Object.keys(expected).filter(name => !screenshots.some(item => path.basename(item.file) === name))
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

module.exports = { inspectScreenshotOrientations, androidOrientationParameters, screenshotDimensions }
