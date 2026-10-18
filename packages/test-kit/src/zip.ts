/**
 * Build a zip archive in memory, for fake release assets. Entries ending in
 * `/` are directories; any name is written verbatim, so tests can also craft
 * hostile archives (`../escape.txt`).
 */
import { crc32, deflateRawSync } from 'node:zlib'

export type ZipEntries = Readonly<Record<string, string | Uint8Array>>

export function makeZip(entries: ZipEntries): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, 'utf8')
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const isDir = name.endsWith('/')
    const data = isDir ? Buffer.alloc(0) : deflateRawSync(raw)
    const crc = isDir ? 0 : crc32(raw)
    const method = isDir ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length * (isDir ? 0 : 1), 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length * (isDir ? 0 : 1), 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(isDir ? 0x10 : 0, 38) // external attributes: directory flag
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  const count = Object.keys(entries).length
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}
