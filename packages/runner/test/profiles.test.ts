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
