import { strict as assert } from 'node:assert'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ExeIcons, extractExeIcon } from '../src/exe-icon.ts'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

test('a program icon is read once and kept; a changed program is read again; a missing one says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-exe-icon-'))
  const exe = join(dir, 'Game.exe')
  writeFileSync(exe, 'v1')
  let reads = 0
  const icons = new ExeIcons(join(dir, 'icons'), async () => { reads += 1; return PNG })
  assert.deepEqual(await icons.png(exe), PNG)
  assert.deepEqual(await icons.png(exe), PNG)
  assert.equal(reads, 1)
  writeFileSync(exe, 'v2 (updated)')
  utimesSync(exe, new Date(), new Date(Date.now() + 5_000))
  await icons.png(exe)
  assert.equal(reads, 2)
  await assert.rejects(icons.png(join(dir, 'Gone.exe')), /找不到/)
})

test('Windows gives a program its own icon at 256 px', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const png = await extractExeIcon('C:\\Windows\\explorer.exe')
  assert.equal(png.readUInt32BE(0), 0x89504e47)
  assert.equal(png.readUInt32BE(16), 256)
})
