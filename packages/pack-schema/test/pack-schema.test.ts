import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { chooseAsset, expand, globToRegExp, versionOfTag } from '../src/match.ts'
import { PackError, parseManifest } from '../src/parse.ts'

const MAA = `
id: maa
name: MaaAssistantArknights
family: gui-config
source:
  github: MaaAssistantArknights/MaaAssistantArknights
  release:
    asset: 'MAA-v{version}-win-x64.zip'
install:
  requires:
    - kind: dotnet-desktop-runtime
      version: '>=8'
config:
  files:
    - path: config/gui.json
      format: json
detect:
  files: [MAA.exe, MaaCore.dll]
tasks:
  - id: daily
    title: 日常
`

test('a manifest parses with defaults filled in', () => {
  const pack = parseManifest(MAA)
  assert.equal(pack.id, 'maa')
  assert.equal(pack.schema, 1)
  assert.equal(pack.source.release?.channel, 'stable')
  assert.deepEqual(pack.install.requires.map(r => r.kind), ['dotnet-desktop-runtime'])
  assert.equal(pack.config.files[0]?.format, 'json')
  assert.equal(pack.tasks?.length, 1, 'later-milestone sections are kept as open objects')
})

test('the smallest manifest is an id and a name', () => {
  const pack = parseManifest('id: tiny\nname: Tiny\n')
  assert.deepEqual(pack.install.requires, [])
  assert.deepEqual(pack.config.files, [])
})

test('schema and YAML errors name the file and every bad path', () => {
  assert.throws(() => parseManifest('id: Bad Id\nname: x\nconfig:\n  files:\n    - path: ../outside.json\n      format: json\n', 'packs/x/adg.script.yaml'), (error: unknown) => {
    assert.ok(error instanceof PackError)
    assert.match(error.message, /^packs\/x\/adg\.script\.yaml: /)
    assert.ok(error.issues.some(i => i.startsWith('id:')))
    assert.ok(error.issues.some(i => i.startsWith('config.files.0.path:')))
    return true
  })
  assert.throws(() => parseManifest('id: [unclosed\n'), PackError)
})

test('globs, templates and tags', () => {
  assert.ok(globToRegExp('MAA-v*-win-x64.zip').test('maa-v6.19.0-WIN-x64.zip'))
  assert.ok(!globToRegExp('MAA-v*-win-x64.zip').test('MAA-v6.19.0-win-x64.zip.sha256'))
  assert.equal(expand('MAA-v{version}-win-x64.zip', { version: '6.19.0' }), 'MAA-v6.19.0-win-x64.zip')
  assert.throws(() => expand('{versoin}', { version: '1' }), /unknown placeholder \{versoin\}/)
  assert.equal(versionOfTag('v6.19.0'), '6.19.0')
  assert.equal(versionOfTag('2026.10.1'), '2026.10.1')
})

const asset = (name: string, size = 1) => ({ name, size })

test('pack globs pick the asset, in order', () => {
  const assets = [asset('MAA-v6.19.0-linux-x86_64.tar.gz'), asset('MAA-v6.19.0-win-x64.zip'), asset('MAA-v6.19.0-win-arm64.zip')]
  const chosen = chooseAsset(assets, { globs: ['MAA-v{version}-win-x64.zip'], tag: 'v6.19.0' })
  assert.equal(chosen.asset?.name, 'MAA-v6.19.0-win-x64.zip')
  assert.equal(chooseAsset(assets, { globs: ['nothing-*.zip'] }).asset, undefined)
})

test('without globs the heuristic prefers this platform and architecture', () => {
  const pick = (...names: string[]) => chooseAsset(names.map(n => asset(n))).asset?.name
  assert.equal(pick('MAA-v6.19.0-macos-universal.dmg', 'MAA-v6.19.0-win-arm64.zip', 'MAA-v6.19.0-win-x64.zip', 'MAA-v6.19.0-linux-x86_64.tar.gz'), 'MAA-v6.19.0-win-x64.zip')
  assert.equal(pick('MaaEnd-win-x86_64-v1.2.0.zip', 'MaaEnd-linux-x86_64-v1.2.0.tar.gz', 'MaaEnd-android-v1.2.0.apk'), 'MaaEnd-win-x86_64-v1.2.0.zip')
  assert.equal(pick('Source code.zip', 'March7thAssistant_v2026.10.17.zip', 'March7thAssistant_v2026.10.17_full.zip', 'checksums.txt'), 'March7thAssistant_v2026.10.17_full.zip')
  assert.equal(pick('tool-update-patch.zip', 'tool-portable.zip'), 'tool-portable.zip')
  assert.equal(pick('app.AppImage', 'app.deb'), undefined, 'nothing for Windows')
  assert.equal(chooseAsset([]).asset, undefined)
})
