import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanVersion, detectVersion, type EnvHost } from '@adg/installer'
import { makeZip, startFakeGitHub } from '@adg/test-kit'
import { ScriptLibrary } from '../src/library.ts'
import { scriptTools, TOOL_NAMES } from '../src/tools.ts'
import { fakeMirror } from './fake-mirror.ts'

const PACK = `id: tool
name: Fake Tool
family: gui-config
source:
  github: Owner/Tool
  release:
    asset: 'Tool-v{version}-win-x64.zip'
  mirrorchyan:
    rid: Tool
    platform: false
config:
  files:
    - path: settings.ini
      format: ini
detect:
  files: [tool.exe]
`

const noHost: EnvHost = { exec: async () => undefined, exists: async () => false, listDir: async () => [], env: () => undefined }

/** A folder the user already had: version 1.0.0, their settings, a file of their own. */
function userFolder(root: string, files: Record<string, string> = {}): string {
  const dir = join(root, 'D-Games', 'Tool')
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(join(dir, 'tool.exe'), 'MZ 1.0.0')
  writeFileSync(join(dir, 'version.txt'), 'v1.0.0\n')
  writeFileSync(join(dir, 'old.txt'), 'old')
  writeFileSync(join(dir, 'settings.ini'), 'mine=1')
  writeFileSync(join(dir, 'config', 'gui.json'), '{"mine":true}')
  writeFileSync(join(dir, 'notes.txt'), 'the user\'s own file')
  for (const [name, content] of Object.entries(files)) {
    if (content === '/') mkdirSync(join(dir, name), { recursive: true })
    else writeFileSync(join(dir, name), content)
  }
  return dir
}

function setup(root: string, options: { github: string; mirror?: string; cdk?: string }) {
  mkdirSync(join(root, 'packs', 'tool'), { recursive: true })
  writeFileSync(join(root, 'packs', 'tool', 'adg.script.yaml'), PACK)
  return new ScriptLibrary({
    toolsDir: join(root, 'tools'), dataDir: join(root, 'data'), packDirs: [join(root, 'packs')],
    defaults: { apiBase: options.github },
    credential: async ref => (ref === 'MIRRORCHYAN_CDK' ? options.cdk : undefined),
    credentialConfigured: async ref => ref === 'MIRRORCHYAN_CDK' && options.cdk !== undefined,
    envHost: noHost,
    ...(options.mirror === undefined ? {} : { mirrorchyanBase: options.mirror }),
    onChanged() {}, onJob() {}, log: { info() {}, warn() {} },
  })
}

test('versions read from a folder: a pack\'s spec, interface.json, version files', async () => {
  assert.equal(cleanVersion('v6.20.1'), '6.20.1')
  assert.equal(cleanVersion('6.20.1.0'), '6.20.1')
  assert.equal(cleanVersion('Version: 2025.10.3'), '2025.10.3')
  assert.equal(cleanVersion('v1.2.3-beta.1'), '1.2.3-beta.1')
  assert.equal(cleanVersion('nightly'), undefined)
  const dir = mkdtempSync(join(tmpdir(), 'adg-version-'))
  assert.equal(await detectVersion(dir), undefined)
  writeFileSync(join(dir, 'version.txt'), '﻿v2.0.0\r\n')
  assert.deepEqual(await detectVersion(dir), { version: '2.0.0', from: 'version.txt' })
  writeFileSync(join(dir, 'interface.json'), JSON.stringify({ name: 'X', version: 'v3.1.0' }))
  assert.deepEqual(await detectVersion(dir), { version: '3.1.0', from: 'interface.json' })
  writeFileSync(join(dir, 'about.json'), JSON.stringify({ app: { ver: 'release 4.0.1' } }))
  assert.deepEqual(await detectVersion(dir, { spec: { file: 'about.json', json: ['app', 'ver'] } }), { version: '4.0.1', from: 'about.json' })
  assert.deepEqual(await detectVersion(dir, { spec: { file: 'missing.txt' } }), { version: '3.1.0', from: 'interface.json' }, 'the usual places when the spec finds nothing')
})

test('a local import updates where it is from GitHub: files backed up, settings and user data left, undo puts it back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-local-'))
  const github = await startFakeGitHub({ repos: { 'Owner/Tool': [{ tag: 'v1.2.0', assets: [{ name: 'Tool-v1.2.0-win-x64.zip', content: makeZip({
    'Tool/': '', 'Tool/tool.exe': 'MZ 1.2.0', 'Tool/version.txt': 'v1.2.0', 'Tool/new.dll': 'MZ', 'Tool/settings.ini': 'default=1',
    'Tool/config/gui.json': '{"default":true}', 'Tool/config/extra.json': '{}', 'Tool/lib/a.dll': 'MZ a',
  }) }] }] } })
  const library = setup(root, { github: github.url })
  await library.start()
  try {
    const dir = userFolder(root)
    let info = await library.import({ path: dir })
    assert.equal(info.packId, 'tool')
    assert.deepEqual(info.localVersion, { version: '1.0.0', from: 'version.txt' })
    assert.equal(info.updateFrom, 'Owner/Tool', 'the pack\'s repository')
    assert.equal(info.updateFromPack, true)
    assert.equal(info.mirrorchyan, 'Tool')

    assert.deepEqual(await library.checkUpdate('tool'), { current: '1.0.0', latest: '1.2.0', available: true })
    const update = await library.update('tool')
    const done = update.upToDate ? undefined : await update.done
    assert.equal(done?.phase, 'done', done?.error)
    assert.equal(readFileSync(join(dir, 'tool.exe'), 'utf8'), 'MZ 1.2.0', 'program replaced in place')
    assert.equal(readFileSync(join(dir, 'lib', 'a.dll'), 'utf8'), 'MZ a', 'new folders made')
    assert.equal(readFileSync(join(dir, 'settings.ini'), 'utf8'), 'mine=1', 'the pack\'s config file left alone')
    assert.equal(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'), '{"mine":true}', 'user data folder left alone')
    assert.ok(existsSync(join(dir, 'config', 'extra.json')), 'new files there are still added')
    assert.ok(existsSync(join(dir, 'old.txt')) && existsSync(join(dir, 'notes.txt')), 'a full package deletes nothing')
    info = library.get('tool')
    assert.deepEqual(info.localVersion, { version: '1.2.0', from: '更新' })
    assert.deepEqual(info.undo && { from: info.undo.from, to: info.undo.to }, { from: '1.0.0', to: '1.2.0' })
    assert.equal(info.current, 'local', 'still one folder, used in place')
    assert.ok(!existsSync(join(root, 'tools', 'tool', '.staging')) && !existsSync(join(root, 'tools', 'tool', '.downloads', 'Tool-v1.2.0-win-x64.zip')))
    assert.deepEqual(await library.checkUpdate('tool'), { current: '1.2.0', latest: '1.2.0', available: false })

    info = await library.restore('tool')
    assert.equal(readFileSync(join(dir, 'tool.exe'), 'utf8'), 'MZ 1.0.0')
    assert.equal(readFileSync(join(dir, 'version.txt'), 'utf8'), 'v1.0.0\n')
    assert.ok(!existsSync(join(dir, 'new.dll')) && !existsSync(join(dir, 'lib', 'a.dll')) && !existsSync(join(dir, 'config', 'extra.json')), 'what the update added is gone')
    assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'the user\'s own file')
    assert.deepEqual(info.localVersion, { version: '1.0.0', from: 'version.txt' })
    assert.equal(info.undo, undefined)
    await assert.rejects(library.restore('tool'), /没有可以撤销的更新/)
  } finally {
    library.dispose()
    await github.close()
  }
})

test('with a CDK a local import gets Mirror酱\'s incremental package from the version found; a file that cannot be written puts everything back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-local-mirror-'))
  const github = await startFakeGitHub({ repos: { 'Owner/Tool': [] } })
  const patch = makeZip({ 'tool.exe': 'MZ 1.1.0', 'version.txt': 'v1.1.0', 'added.dll': 'MZ', 'changes.json': JSON.stringify({ modified: ['tool.exe', 'version.txt'], added: ['added.dll'], deleted: ['old.txt', 'settings.ini'] }) })
  const mirror = await fakeMirror({ latest: 'v1.1.0', cdk: 'good', full: makeZip({ 'tool.exe': 'full' }), incremental: { from: 'v1.0.0', body: patch } })
  const library = setup(root, { github: github.url, mirror: mirror.url, cdk: 'good' })
  await library.start()
  try {
    const dir = userFolder(root)
    await library.import({ path: dir })
    assert.deepEqual(await library.checkUpdate('tool'), { current: '1.0.0', latest: '1.1.0', available: true })
    const update = await library.update('tool')
    const done = update.upToDate ? undefined : await update.done
    assert.equal(done?.phase, 'done', done?.error)
    assert.equal(mirror.asked.at(-1)?.get('current_version'), 'v1.0.0', 'asked from the version in the folder')
    assert.equal(readFileSync(join(dir, 'tool.exe'), 'utf8'), 'MZ 1.1.0')
    assert.ok(existsSync(join(dir, 'added.dll')))
    assert.ok(!existsSync(join(dir, 'old.txt')), 'changes.json deletions applied')
    assert.ok(existsSync(join(dir, 'settings.ini')), 'but never the pack\'s config files')
    assert.ok(!existsSync(join(dir, 'changes.json')))
    assert.equal(github.requests.length, 0)
    await library.restore('tool')
    assert.equal(readFileSync(join(dir, 'old.txt'), 'utf8'), 'old', 'a deleted file comes back')
    assert.ok(!existsSync(join(dir, 'added.dll')))

    // A file that cannot be written (a folder in its place): tool.exe, written before it, goes back.
    await library.remove('tool')
    const blocked = userFolder(join(root, 'second'))
    rmSync(join(blocked, 'version.txt'))
    mkdirSync(join(blocked, 'version.txt'))
    writeFileSync(join(blocked, 'interface.json'), JSON.stringify({ version: 'v1.0.0' }))
    await library.import({ path: blocked })
    const failing = await library.update('tool')
    const failed = failing.upToDate ? undefined : await failing.done
    assert.equal(failed?.phase, 'failed')
    assert.match(failed?.error ?? '', /version\.txt.*已改回更新前的文件/)
    assert.equal(readFileSync(join(blocked, 'tool.exe'), 'utf8'), 'MZ 1.0.0', 'the file written before the failure is back')
    assert.ok(!existsSync(join(blocked, 'added.dll')), 'nothing added stays')
    assert.ok(existsSync(join(blocked, 'old.txt')))
    assert.equal(library.get('tool').undo, undefined, 'nothing to undo')
  } finally {
    library.dispose()
    await mirror.close()
    await github.close()
  }
})

test('a local import without a pack: no source until the user names its repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-local-source-'))
  const github = await startFakeGitHub({ repos: { 'Someone/Other': [{ tag: 'v2.0.0', assets: [{ name: 'Other-v2.0.0-win-x64.zip', content: makeZip({ 'other.exe': 'MZ 2' }) }] }] } })
  const library = setup(root, { github: github.url })
  await library.start()
  try {
    const dir = join(root, 'Other')
    mkdirSync(dir)
    writeFileSync(join(dir, 'other.exe'), 'MZ 1')
    let info = await library.import({ path: dir })
    assert.equal(info.updateFrom, undefined)
    assert.equal(info.localVersion, undefined, 'nothing says its version')
    await assert.rejects(library.checkUpdate(info.id), /还没有更新来源/)
    info = await library.setUpdateSource(info.id, 'Someone/Other')
    assert.equal(info.updateFrom, 'Someone/Other')
    assert.equal(info.updateFromPack, false)
    assert.deepEqual(await library.checkUpdate(info.id), { latest: '2.0.0', available: true }, 'an unknown version can be updated')
    const update = await library.update(info.id)
    const done = update.upToDate ? undefined : await update.done
    assert.equal(done?.phase, 'done', done?.error)
    assert.equal(readFileSync(join(dir, 'other.exe'), 'utf8'), 'MZ 2')
    assert.equal(library.get(info.id).undo?.from, undefined)
    info = await library.setUpdateSource(info.id, null)
    assert.equal(info.updateFrom, undefined)
    await assert.rejects(library.checkUpdate(info.id), /还没有更新来源/)

    // The agent: the source and the in-place update are both asked; a refusal changes nothing.
    await library.restore(info.id)
    assert.equal(library.get(info.id).localVersion, undefined, 'back to not knowing')
    const exec = { signal: new AbortController().signal } as never
    const refusing = scriptTools(library, async () => { throw new Error('用户拒绝了这个操作') })
    await assert.rejects(refusing.find(t => t.name === TOOL_NAMES.update)!.execute({ id: info.id, repo: 'Someone/Other' }, exec), /用户拒绝/)
    assert.equal(library.get(info.id).updateFrom, undefined)
    const asked: string[] = []
    const tools = scriptTools(library, async (_exec, reason) => { asked.push(reason) })
    const result = await tools.find(t => t.name === TOOL_NAMES.update)!.execute({ id: info.id, repo: 'Someone/Other' }, exec) as { ok: boolean }
    assert.equal(result.ok, true)
    assert.equal(asked.length, 2)
    assert.match(asked[0]!, /更新来源.*Someone\/Other.*不在内置脚本包里/)
    assert.match(asked[1]!, /更新到 2\.0\.0.*先备份/)
    assert.equal(readFileSync(join(dir, 'other.exe'), 'utf8'), 'MZ 2')
    await tools.find(t => t.name === TOOL_NAMES.rollback)!.execute({ id: info.id }, exec)
    assert.equal(readFileSync(join(dir, 'other.exe'), 'utf8'), 'MZ 1', 'script_rollback undoes the in-place update')
  } finally {
    library.dispose()
    await github.close()
  }
})
