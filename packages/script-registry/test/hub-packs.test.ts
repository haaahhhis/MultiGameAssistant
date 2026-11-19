import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadPacks } from '../src/packs.ts'

const maa = readFileSync(new URL('../../packs/packs/maa/adg.script.yaml', import.meta.url), 'utf8')

test('the 技能库\'s downloads are packs: official by where each came from, its SKILL.md left to the hub; a user pack still wins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-hub-packs-'))
  const hub = join(root, 'skill-hub', 'skills')
  for (const [name, files] of Object.entries({
    maa: { 'adg.script.yaml': maa, 'SKILL.md': '---\nname: maa\ndescription: MAA\n---\n' },
    other: { 'adg.script.yaml': maa.replace(/^id: maa$/m, 'id: other'), 'SKILL.md': '---\nname: other\ndescription: x\n---\n' },
    'game-arknights': { 'game.yaml': 'id: arknights\n', 'SKILL.md': '---\nname: game-arknights\ndescription: x\n---\n' },
  })) {
    mkdirSync(join(hub, name), { recursive: true })
    for (const [file, text] of Object.entries(files)) writeFileSync(join(hub, name, file), text)
  }
  const { packs, errors } = await loadPacks([{ dir: hub, builtin: false, trusted: id => id === 'maa', hub: true }])
  assert.deepEqual(errors, [])
  assert.deepEqual([...packs.keys()].sort(), ['maa', 'other'], 'a game pack\'s folder is no script pack')
  assert.equal(packs.get('maa')?.builtin, true, 'from the default repository')
  assert.equal(packs.get('other')?.builtin, false, 'from a repository the user added')
  assert.equal(packs.get('maa')?.hub, true)

  const user = join(root, 'packs')
  mkdirSync(join(user, 'maa'), { recursive: true })
  writeFileSync(join(user, 'maa', 'adg.script.yaml'), maa)
  const both = await loadPacks([{ dir: hub, builtin: false, trusted: id => id === 'maa', hub: true }, { dir: user, builtin: false }])
  assert.equal(both.packs.get('maa')?.hub, undefined, 'the user\'s own revision is used')
  assert.equal(both.packs.get('maa')?.over?.hub, true, 'and the official one is what it goes back to')
})
