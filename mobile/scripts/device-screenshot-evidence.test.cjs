const test = require('node:test')
const assert = require('node:assert/strict')
const { screenshotDimensions, androidOrientationParameters } = require('./device-screenshot-evidence.cjs')

// Metadata-only fixtures exercise the checker, not rendering or device behavior.
function chunk(type, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length)
  bytes.write(type, 4, 'ascii')
  data.copy(bytes, 8)
  return bytes
}
function png(...metadata) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1206)
  header.writeUInt32BE(2622, 4)
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...metadata, chunk('IEND')])
}
function exif(value, littleEndian = false) {
  // TIFF IFD0 with one inline SHORT Orientation entry and no next directory.
  const data = Buffer.from(littleEndian
    ? '49492a0008000000010012010300010000000100000000000000'
    : '4d4d002a00000008000101120003000000010001000000000000', 'hex')
  if (littleEndian) data.writeUInt16LE(value, 18)
  else data.writeUInt16BE(value, 18)
  return data
}

test('PNG without EXIF keeps the stored dimensions', () => {
  assert.deepEqual(screenshotDimensions(png()), {
    pixelWidth: 1206, pixelHeight: 2622, exifOrientation: 1, width: 1206, height: 2622,
  })
})

test('TIFF orientations use display axes in both byte orders', () => {
  for (const littleEndian of [false, true]) {
    for (let value = 1; value <= 8; value++) {
      const result = screenshotDimensions(png(chunk('eXIf', exif(value, littleEndian))))
      assert.equal(result.exifOrientation, value)
      assert.equal(result.width, value >= 5 ? 2622 : 1206)
      assert.equal(result.height, value >= 5 ? 1206 : 2622)
      assert.equal(result.pixelWidth, 1206)
      assert.equal(result.pixelHeight, 2622)
    }
  }
})

test('malformed or ambiguous orientation metadata fails instead of assuming success', () => {
  for (const value of [0, 9]) assert.throws(() => screenshotDimensions(png(chunk('eXIf', exif(value)))))
  const invalidOffset = exif(8)
  invalidOffset.writeUInt32BE(0xffffffff, 4)
  assert.throws(() => screenshotDimensions(png(chunk('eXIf', invalidOffset))), /directory offset/)
  const invalidType = exif(8)
  invalidType.writeUInt16BE(4, 12)
  assert.throws(() => screenshotDimensions(png(chunk('eXIf', invalidType))), /orientation entry/)
  const invalidCount = exif(8)
  invalidCount.writeUInt32BE(2, 14)
  assert.throws(() => screenshotDimensions(png(chunk('eXIf', invalidCount))), /orientation entry/)
  assert.throws(() => screenshotDimensions(png(chunk('eXIf', exif(8).subarray(0, 12)))), /Truncated/)
  assert.throws(() => screenshotDimensions(png(chunk('eXIf', exif(8)), chunk('eXIf', exif(1)))), /Multiple/)
})

test('truncated PNG chunks and invalid headers are rejected', () => {
  const original = png(chunk('eXIf', exif(8)))
  for (const length of [0, 23, 40, original.length - 1]) {
    assert.throws(() => screenshotDimensions(original.subarray(0, length)))
  }
  const zeroWidth = png()
  zeroWidth.writeUInt32BE(0, 16)
  assert.throws(() => screenshotDimensions(zeroWidth), /dimensions/)
})

test('Android natural landscape tablets map rotation commands separately from phones', () => {
  assert.deepEqual(androidOrientationParameters('Physical size: 2560x1600'), {
    portrait: 'LANDSCAPE_LEFT', landscape: 'PORTRAIT',
  })
  assert.deepEqual(androidOrientationParameters('Physical size: 1080x2400'), {
    portrait: 'PORTRAIT', landscape: 'LANDSCAPE_LEFT',
  })
  assert.throws(() => androidOrientationParameters('Physical size: 1000x1000'))
})
