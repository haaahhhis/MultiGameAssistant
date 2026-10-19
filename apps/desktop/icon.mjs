/**
 * The tray icon, drawn at start-up: an accent-coloured rounded square with
 * the app's layered mark, at any size. No binary asset to ship or keep in sync.
 */
import { deflateSync } from 'node:zlib'

const ACCENT = [0x52, 0x64, 0xdc]

/** @param {number} size @returns {Buffer} PNG bytes */
export function trayIconPng(size = 32) {
  const rgba = Buffer.alloc(size * size * 4)
  const r = size * 0.22
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - r)
    const cy = Math.min(Math.max(y, r), size - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  }
  // Two stacked chevrons, like the "layers" mark of the UI.
  const mark = (x, y) => {
    const u = (x - size / 2) / size
    const v = (y - size / 2) / size
    const t = 0.055
    const diamond = Math.abs(u) * 0.9 + Math.abs(v + 0.1) <= 0.3 && Math.abs(u) * 0.9 + Math.abs(v + 0.1) >= 0.3 - t * 1.6
    const chevron = Math.abs(v - 0.12 - Math.abs(u) * -0.55) <= t && Math.abs(u) <= 0.3 && v > 0
    return diamond || chevron
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      // 4x supersampling for smooth edges.
      let fill = 0
      let white = 0
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        if (!inside(x + dx, y + dy)) continue
        fill++
        if (mark(x + dx, y + dy)) white++
      }
      const a = fill / 4
      const w = fill === 0 ? 0 : white / fill
      rgba[i] = Math.round(ACCENT[0] + (255 - ACCENT[0]) * w)
      rgba[i + 1] = Math.round(ACCENT[1] + (255 - ACCENT[1]) * w)
      rgba[i + 2] = Math.round(ACCENT[2] + (255 - ACCENT[2]) * w)
      rgba[i + 3] = Math.round(255 * a)
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type, data) {
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

function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
