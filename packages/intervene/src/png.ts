/**
 * Just enough PNG for screenshots: decode 8-bit RGB / RGBA (what `adb
 * screencap` and System.Drawing write), shrink by area averaging, encode
 * RGBA. Keeps screenshots inside a model's image limits without a native
 * image library.
 */
import { deflateSync, inflateSync } from 'node:zlib'

export interface Raster {
  readonly width: number
  readonly height: number
  /** RGBA, row-major. */
  readonly data: Buffer
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE)) return undefined
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** @throws Error for something that is not an 8-bit, non-interlaced RGB or RGBA PNG. */
export function decodePng(png: Buffer): Raster {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG 图片')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]!
      colorType = body[9]!
      if (depth !== 8 || (colorType !== 2 && colorType !== 6) || body[12] !== 0) throw new Error(`不支持的 PNG 格式（位深 ${depth}，颜色类型 ${colorType}）`)
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const out = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels]! : 0
      const b = previous[x]!
      const c = x >= channels ? previous[x - channels]! : 0
      let value = line[x]!
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[x] = value & 0xff
    }
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      out[i] = line[x * channels]!
      out[i + 1] = line[x * channels + 1]!
      out[i + 2] = line[x * channels + 2]!
      out[i + 3] = channels === 4 ? line[x * channels + 3]! : 255
    }
    previous = line
  }
  return { width, height, data: out }
}

/** Shrink so the longer side is at most `maxEdge` (area averaging); smaller images come back as they are. */
export function shrink(raster: Raster, maxEdge: number): Raster {
  const scale = Math.min(1, maxEdge / Math.max(raster.width, raster.height))
  if (scale >= 1) return raster
  const width = Math.max(1, Math.round(raster.width * scale))
  const height = Math.max(1, Math.round(raster.height * scale))
  const out = Buffer.alloc(width * height * 4)
  const fx = raster.width / width
  const fy = raster.height / height
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * fy)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * fx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx))
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * raster.width + sx) * 4
          r += raster.data[i]!; g += raster.data[i + 1]!; b += raster.data[i + 2]!; a += raster.data[i + 3]!
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * width + x) * 4
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n)
    }
  }
  return { width, height, data: out }
}

export function encodePng(raster: Raster): Buffer {
  const stride = raster.width * 4
  const raw = Buffer.alloc((stride + 1) * raster.height)
  for (let y = 0; y < raster.height; y++) {
    // Sub filter: cheap and compresses screenshots well.
    raw[y * (stride + 1)] = 1
    for (let x = 0; x < stride; x++) {
      const value = raster.data[y * stride + x]!
      const left = x >= 4 ? raster.data[y * stride + x - 4]! : 0
      raw[y * (stride + 1) + 1 + x] = (value - left) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(raster.width, 0)
  ihdr.writeUInt32BE(raster.height, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

/** A PNG no larger than `maxEdge` on its longer side, and the factor applied. */
export function fitPng(png: Buffer, maxEdge: number): { png: Buffer; width: number; height: number; scale: number } {
  const size = pngSize(png)
  if (size === undefined) throw new Error('截图不是 PNG')
  if (Math.max(size.width, size.height) <= maxEdge) return { png, ...size, scale: 1 }
  const small = shrink(decodePng(png), maxEdge)
  return { png: encodePng(small), width: small.width, height: small.height, scale: small.width / size.width }
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
