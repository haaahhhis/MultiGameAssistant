import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseManifest } from '@adg/pack-schema'
import { ConfigProfiles } from '../src/profiles.ts'

const MANIFEST = parseManifest(`
id: tool
name: Tool
config:
  files:
    - { path: config/gui.json, format: json }
    - { path: 'config/presets/*.yaml', format: yaml }
    - { path: config/later.json, format: json }
`)

function setup() {
  const script = mkdtempSync(join(tmpdir(), 'adg-prof-script-'))
  const data = mkdtempSync(join(tmpdir(), 'adg-prof-data-'))
  mkdirSync(join(script, 'config', 'presets'), { recursive: true })
  writeFileSync(join(script, 'config', 'gui.json'), '{\n  "Stage": "1-7",\n  "Run": false\n}\n')
  writeFileSync(join(script, 'config', 'presets', 'a.yaml'), '# my preset\nlevel: 1\n')
  return { script, data, profiles: new ConfigProfiles(data) }
}

test('the local copy is imported once, edited apart from the original, and globs expand', async () => {
  const { script, data, profiles } = setup()
  assert.equal(await profiles.ensure('tool', script, MANIFEST), true)
  assert.equal(await profiles.ensure('tool', script, MANIFEST), false, 'only the first time')
  const status = await profiles.status('tool', script, MANIFEST)
  assert.deepEqual(status.files.map(f => [f.file, f.local, f.original]), [
    ['config/gui.json', true, true], ['config/later.json', false, false], ['config/presets/a.yaml', true, true],
  ])
  assert.deepEqual(status.drift, [])

  await profiles.write('tool', script, MANIFEST, 'config/gui.json', ['Stage'], 'CE-6', join(data, 'history', 't1'))
  assert.match(readFileSync(join(profiles.filesDir('tool'), 'config', 'gui.json'), 'utf8'), /"Stage": "CE-6"/)
  assert.match(readFileSync(join(script, 'config', 'gui.json'), 'utf8'), /"Stage": "1-7"/, 'the original is untouched')
  assert.match(readFileSync(join(data, 'history', 't1', 'config', 'gui.json'), 'utf8'), /"1-7"/, 'the previous local file is kept')
  await assert.rejects(profiles.read('tool', script, MANIFEST, 'config/later.json'), /还没有 config\/later\.json/)
})

test('a run injects local + patches and restores the original exactly, deleting files that were not there', async () => {
  const { script, data, profiles } = setup()
  const original = readFileSync(join(script, 'config', 'gui.json'))
  await profiles.ensure('tool', script, MANIFEST)
  await profiles.write('tool', script, MANIFEST, 'config/gui.json', ['Stage'], 'CE-6', join(data, 'h'))
  // A file only the local copy has (e.g. saved in an earlier settings session).
  mkdirSync(join(profiles.filesDir('tool'), 'config'), { recursive: true })
  writeFileSync(join(profiles.filesDir('tool'), 'config', 'later.json'), '{"x":1}')

  const injection = await profiles.inject('tool', script, MANIFEST, [
    { file: 'config/gui.json', required: false, set: [{ path: ['Run'], value: true }] },
    { file: 'config/missing.json', required: false, set: [{ path: ['a'], value: 1 }] },
  ], join(data, 'backup'))
  const during = JSON.parse(readFileSync(join(script, 'config', 'gui.json'), 'utf8'))
  assert.deepEqual(during, { Stage: 'CE-6', Run: true }, 'local edit plus the task patch')
  assert.ok(existsSync(join(script, 'config', 'later.json')))
  assert.deepEqual(injection.skipped, ['config/missing.json'])
  assert.deepEqual([...injection.files].sort(), ['config/gui.json', 'config/later.json'])

  writeFileSync(join(script, 'config', 'gui.json'), '{"scriptWroteThis": true}') // the script saves state while running
  await injection.restore()
  assert.deepEqual(readFileSync(join(script, 'config', 'gui.json')), original, 'byte for byte')
  assert.ok(!existsSync(join(script, 'config', 'later.json')), 'a file that did not exist before is removed again')
  assert.doesNotMatch(readFileSync(join(profiles.filesDir('tool'), 'config', 'gui.json'), 'utf8'), /scriptWroteThis/, 'a normal run discards what the script wrote')
  await assert.rejects(profiles.inject('tool', script, MANIFEST, [{ file: 'config/missing.json', required: true, set: [{ path: ['a'], value: 1 }] }], join(data, 'b2')), /缺少配置文件/)
})

test('a settings session saves what the script wrote back into the local copy', async () => {
  const { script, data, profiles } = setup()
  const original = readFileSync(join(script, 'config', 'gui.json'))
  const injection = await profiles.inject('tool', script, MANIFEST, [], join(data, 'backup'))
  writeFileSync(join(script, 'config', 'gui.json'), '{"Stage": "H8-4"}')
  writeFileSync(join(script, 'config', 'presets', 'b.yaml'), 'level: 2\n')
  assert.deepEqual((await injection.saveBack()).sort(), ['config/gui.json', 'config/presets/a.yaml', 'config/presets/b.yaml'])
  await injection.restore()
  assert.deepEqual(readFileSync(join(script, 'config', 'gui.json')), original)
  assert.equal(readFileSync(join(profiles.filesDir('tool'), 'config', 'gui.json'), 'utf8'), '{"Stage": "H8-4"}')
  assert.ok(existsSync(join(profiles.filesDir('tool'), 'config', 'presets', 'b.yaml')))
})

test('profiles: saved from a copy, the original or another folder; named, made current, removed', async () => {
  const { script, data, profiles } = setup()
  assert.deepEqual(await profiles.list('tool'), { current: 'default', items: [{ id: 'default', name: '默认' }] })
  await profiles.write('tool', script, MANIFEST, 'config/gui.json', ['Stage'], 'CE-6', join(data, 'h1'))

  const copy = await profiles.create('tool', script, MANIFEST, '小号', { kind: 'copy', profile: 'default' }, 1000)
  assert.deepEqual(copy.files, ['config/gui.json', 'config/presets/a.yaml'])
  assert.match(await profiles.read('tool', script, MANIFEST, 'config/gui.json', copy.profile.id), /CE-6/, 'a copy takes the local edits')
  await profiles.write('tool', script, MANIFEST, 'config/gui.json', ['Stage'], 'H8-4', join(data, 'h2'), copy.profile.id)
  assert.match(await profiles.read('tool', script, MANIFEST, 'config/gui.json'), /CE-6/, 'editing one profile leaves the others')

  const fresh = await profiles.create('tool', script, MANIFEST, '原样', { kind: 'original' }, 2000)
  assert.match(await profiles.read('tool', script, MANIFEST, 'config/gui.json', fresh.profile.id), /1-7/)

  const other = mkdtempSync(join(tmpdir(), 'adg-prof-other-'))
  mkdirSync(join(other, 'config'), { recursive: true })
  writeFileSync(join(other, 'config', 'gui.json'), '{"Stage": "5-3"}')
  const folder = await profiles.create('tool', script, MANIFEST, '另一台电脑', { kind: 'folder', dir: other }, 3000)
  assert.deepEqual(folder.files, ['config/gui.json'])
  assert.match(await profiles.read('tool', script, MANIFEST, 'config/gui.json', folder.profile.id), /5-3/)
  assert.deepEqual((await profiles.status('tool', script, MANIFEST, folder.profile.id)).drift, [], 'drift is judged against the script, not the folder read from')
  await assert.rejects(profiles.create('tool', script, MANIFEST, '空', { kind: 'folder', dir: mkdtempSync(join(tmpdir(), 'adg-prof-empty-')) }), /没有这个脚本的配置文件/)

  await assert.rejects(profiles.create('tool', script, MANIFEST, '小号', { kind: 'original' }), /已经有叫「小号」的配置了/)
  assert.equal((await profiles.resolve('tool', '小号')).id, copy.profile.id, 'found by name')
  await profiles.rename('tool', '小号', '副号')
  await profiles.setCurrent('tool', '副号')
  assert.equal((await profiles.resolve('tool')).name, '副号', 'no name: the current one')
  await assert.rejects(profiles.remove('tool', 'default'), /「默认」配置不能删除/)
  await profiles.remove('tool', '副号')
  const after = await profiles.list('tool')
  assert.equal(after.current, 'default')
  assert.deepEqual(after.items.map(i => i.name), ['默认', '原样', '另一台电脑'])
  assert.ok(!existsSync(profiles.filesDir('tool', copy.profile.id)))
})

test('changes the user makes in the script itself show up as drift until imported', async () => {
  const { script, profiles } = setup()
  await profiles.ensure('tool', script, MANIFEST)
  writeFileSync(join(script, 'config', 'gui.json'), '{"Stage": "changed in the GUI"}')
  assert.deepEqual((await profiles.status('tool', script, MANIFEST)).drift, ['config/gui.json'])
  const imported = await profiles.importFromOriginal('tool', script, MANIFEST)
  assert.deepEqual(imported.sort(), ['config/gui.json', 'config/presets/a.yaml'])
  assert.deepEqual((await profiles.status('tool', script, MANIFEST)).drift, [])
  assert.match(readFileSync(join(profiles.filesDir('tool'), 'config', 'gui.json'), 'utf8'), /changed in the GUI/)
})
