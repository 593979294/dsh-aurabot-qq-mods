// 图片 → ESC/POS 光栅位图。
// 纯 JS 解码 JPEG/PNG，按纸宽缩放、转灰度、可选 Floyd–Steinberg 抖动。
import jpeg from 'jpeg-js'
import pngjs from 'pngjs'

const { PNG } = pngjs

export const MAX_SOURCE_BYTES = 8 * 1024 * 1024
export const MAX_SOURCE_PIXELS = 16_000_000

export function decodeImage(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  if (!bytes.length) throw new Error('图片是空的')
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('图片太大（最多 8MB）')
  let png
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    png = PNG.sync.read(bytes)
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    png = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true })
  } else {
    throw new Error('只支持 JPEG / PNG 图片')
  }
  if (!png || !png.width || !png.height || !png.data) throw new Error('图片解码失败')
  if (png.width * png.height > MAX_SOURCE_PIXELS) throw new Error('图片分辨率太高')
  return { width: png.width, height: png.height, data: png.data }
}

// RGBA → 灰度；透明部分按白纸处理。
export function toGray(image) {
  const { width, height, data } = image
  const gray = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const alpha = data[p + 3] / 255
    const value = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]
    gray[i] = Math.round(value * alpha + 255 * (1 - alpha))
  }
  return { width, height, gray }
}

// 缩小用面积平均，放大用双线性，避免热敏纸上出现明显锯齿。
function resample({ width, height, gray }, dw, dh) {
  const out = new Uint8Array(dw * dh)
  if (dw <= width && dh <= height) {
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor((y * height) / dh)
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / dh))
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor((x * width) / dw)
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / dw))
        let sum = 0
        let count = 0
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            sum += gray[sy * width + sx]
            count++
          }
        }
        out[y * dw + x] = Math.round(sum / Math.max(1, count))
      }
    }
    return out
  }
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(height - 1, Math.max(0, ((y + 0.5) * height) / dh - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(height - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(width - 1, Math.max(0, ((x + 0.5) * width) / dw - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(width - 1, x0 + 1)
      const wx = fx - x0
      const top = gray[y0 * width + x0] * (1 - wx) + gray[y0 * width + x1] * wx
      const bottom = gray[y1 * width + x0] * (1 - wx) + gray[y1 * width + x1] * wx
      out[y * dw + x] = Math.round(top * (1 - wy) + bottom * wy)
    }
  }
  return out
}

function packBits(gray, width, height, { dither, threshold }) {
  const bytesPerRow = Math.ceil(width / 8)
  const bits = Buffer.alloc(bytesPerRow * height)
  const work = dither ? Float32Array.from(gray) : null
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const value = work ? work[index] : gray[index]
      if (value < threshold) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7)
      if (!work) continue
      const error = value - (value < threshold ? 0 : 255)
      const spread = (dx, dy, weight) => {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || nx >= width || ny >= height) return
        work[ny * width + nx] += error * weight
      }
      spread(1, 0, 7 / 16)
      spread(-1, 1, 3 / 16)
      spread(0, 1, 5 / 16)
      spread(1, 1, 1 / 16)
    }
  }
  return { width, height, data: bits }
}

/**
 * 把图片做成适合热敏纸的光栅位图。
 * maxWidthDots 一般是有效纸宽 × 8；图片会铺满纸宽，并按比例缩放高度。
 * 太高时整体缩小，保证一屏能打完。
 */
export function imageRaster(buffer, { maxWidthDots = 384, maxHeightDots = 800, dither = true, threshold = 128 } = {}) {
  const decoded = decodeImage(buffer)
  const gray = toGray(decoded)
  let dw = Math.max(1, Math.round(Number(maxWidthDots) || 384))
  let dh = Math.max(1, Math.round((decoded.height * dw) / decoded.width))
  const cap = Math.round(Number(maxHeightDots) || 0)
  if (cap > 0 && dh > cap) {
    const ratio = cap / dh
    dw = Math.max(1, Math.round(dw * ratio))
    dh = cap
  }
  const scaled = resample(gray, dw, dh)
  return packBits(scaled, dw, dh, { dither: dither !== false, threshold: Number(threshold) || 128 })
}
