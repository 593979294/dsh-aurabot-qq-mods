import test from 'node:test'
import assert from 'node:assert/strict'
import pngjs from 'pngjs'
import { decodeImage, toGray, imageRaster } from '../lib/image.mjs'
import { rasterCommand, buildReceiptBytes } from '../lib/escpos.mjs'

const { PNG } = pngjs

function makePng(width, height, pixels) {
  const png = new PNG({ width, height })
  pixels.forEach((color, i) => {
    png.data[i * 4] = color
    png.data[i * 4 + 1] = color
    png.data[i * 4 + 2] = color
    png.data[i * 4 + 3] = 255
  })
  return PNG.sync.write(png)
}

test('PNG 解码成 RGBA 并转灰度', () => {
  const png = makePng(2, 2, [0, 255, 255, 0])
  const image = decodeImage(png)
  assert.equal(image.width, 2)
  assert.equal(image.height, 2)
  const gray = toGray(image)
  assert.deepEqual([...gray.gray], [0, 255, 255, 0])
})

test('图片按纸宽缩放并打包成 1bpp', () => {
  // 3x2：第一行黑白黑，第二行白白黑
  const png = makePng(3, 2, [0, 255, 0, 255, 255, 0])
  const raster = imageRaster(png, { maxWidthDots: 3, maxHeightDots: 2, dither: false })
  assert.equal(raster.width, 3)
  assert.equal(raster.height, 2)
  assert.equal(raster.data.length, 2)
  assert.equal(raster.data[0], 0b10100000)
  assert.equal(raster.data[1], 0b00100000)
})

test('图片按最大高度等比缩小', () => {
  const png = makePng(4, 10, new Array(40).fill(128))
  const raster = imageRaster(png, { maxWidthDots: 40, maxHeightDots: 20, dither: false })
  assert.equal(raster.height, 20)
  assert.equal(raster.width, 8)
})

test('rasterCommand 生成 GS v 0 头，并把不足一行的位补齐', () => {
  const command = rasterCommand({ width: 10, height: 3, data: Buffer.from([0xff, 0xff, 0xff]) })
  assert.deepEqual([...command.subarray(0, 8)], [0x1b, 0x61, 0x01, 0x1d, 0x76, 0x30, 0x00, 0x02])
  assert.equal(command[8], 0x00)
  assert.equal(command[9], 0x03, 'yL')
  assert.equal(command[10], 0x00, 'yH')
  assert.equal(command.length, 3 + 8 + 2 * 3 + 1 + 3)
})

test('buildReceiptBytes 把图片放在文字之后、切纸之前', () => {
  const raster = { width: 8, height: 1, data: Buffer.from([0xff]) }
  const bytes = buildReceiptBytes([{ text: '正文' }], {
    encoding: 'utf8',
    cut: 'partial',
    images: [raster],
  })
  const text = bytes.toString('utf8')
  assert.ok(text.indexOf('正文') < text.indexOf('\x1dv0'))
  assert.ok(text.indexOf('\x1dv0') < text.indexOf('\x1dV'))
})
