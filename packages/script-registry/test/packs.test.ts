import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadPacks } from '../src/packs.ts'

const manifest = (id: string, title: string) => `id: ${id}\nname: ${id}\nlaunch:\n  exe: Tool.exe\ntasks:\n  - id: run\n    title: ${title}\n`

test('a user pack is used instead of the built-in one of its id, and says which one it stands in for', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-packs-'))
  const pack = (dir: string, id: string, title: string) => {
    mkdirSync(join(root, dir, id), { recursive: true })
    writeFileSync(join(root, dir, id, 'adg.script.yaml'), manifest(id, title))
  }
  pack('builtin', 'maa', '内置')
  pack('builtin', 'other', '内置')
  pack('user', 'maa', '自己写的')
  pack('user', 'mine', '自己写的')
  const { packs, errors } = await loadPacks([{ dir: join(root, 'builtin'), builtin: true }, { dir: join(root, 'user'), builtin: false }])
  assert.deepEqual(errors, [])
  const maa = packs.get('maa')!
  assert.equal(maa.builtin, false)
  assert.equal(maa.manifest.tasks[0]?.title, '自己写的')
  assert.equal(maa.over?.manifest.tasks[0]?.title, '内置', 'the built-in pack is what comes back when the user pack goes')
  assert.equal(packs.get('other')?.over, undefined)
  assert.equal(packs.get('mine')?.over, undefined, 'a user pack of its own stands in for nothing')
})
