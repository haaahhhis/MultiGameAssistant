import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EnvHost } from '@adg/installer'
import type { ScriptJob } from '@adg/protocol'
import { makeZip, startFakeGitHub } from '@adg/test-kit'
import { ScriptLibrary } from '../src/library.ts'
import { scriptTools, TOOL_NAMES } from '../src/tools.ts'
import { fakeMirror } from './fake-mirror.ts'

const noHost: EnvHost = { exec: async () => undefined, exists: async () => false, listDir: async () => [], env: () => undefined }

function setup(root: string, options: { github: string; mirror: string; cdk?: () => string | undefined }) {
  mkdirSync(join(root, 'packs'), { recursive: true })
  const jobs: ScriptJob[] = []
  const library = new ScriptLibrary({
    toolsDir: join(root, 'tools'), dataDir: join(root, 'data'), packDirs: [join(root, 'packs')],
    defaults: { apiBase: options.github },
    credential: async ref => (ref === 'MIRRORCHYAN_CDK' ? options.cdk?.() : undefined),
    credentialConfigured: async ref => ref === 'MIRRORCHYAN_CDK' && options.cdk?.() !== undefined,
    envHost: noHost, mirrorchyanBase: options.mirror,
    onChanged() {}, onJob: job => jobs.push(job), log: { info() {}, warn() {} },
  })
  return { library, jobs }
}

test('a BetterGI folder imported without a pack is recognized: both channels known, updated from Mirror酱 with a CDK', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-bgi-'))
  // GitHub has nothing: if it were asked, the update would fail.
  const github = await startFakeGitHub({ repos: {} })
  const mirror = await fakeMirror({ rid: 'BGI', latest: '0.66.0', cdk: 'good', full: makeZip({ 'BetterGI.exe': 'MZ 0.66.0', 'BetterGI.dll': 'MZ' }) })
  let cdk: string | undefined
  const { library, jobs } = setup(root, { github: github.url, mirror: mirror.url, cdk: () => cdk })
  await library.start()
  try {
    const dir = join(root, 'Downloads', 'BetterGI')
    mkdirSync(join(dir, 'User'), { recursive: true })
    writeFileSync(join(dir, 'BetterGI.exe'), 'MZ 0.65.0')
    writeFileSync(join(dir, 'User', 'config.json'), '{"mine":true}')
    let info = await library.import({ path: dir })
    assert.equal(info.id, 'bettergi')
    assert.equal(info.known, 'bettergi')
    assert.equal(info.name, 'BetterGI（原神）')
    assert.deepEqual(info.channels, { github: { repo: 'babalae/better-genshin-impact', from: 'known' }, mirrorchyan: { rid: 'BGI', from: 'known' } })
    assert.ok(library.list().known.some(k => k.id === 'bettergi' && k.installed && k.mirrorchyan === 'BGI'))

    cdk = 'good'
    assert.deepEqual(await library.checkUpdate('bettergi'), { latest: '0.66.0', available: true })
    const update = await library.update('bettergi')
    const done = update.upToDate ? undefined : await update.done
    assert.equal(done?.phase, 'done', done?.error)
    assert.equal(readFileSync(join(dir, 'BetterGI.exe'), 'utf8'), 'MZ 0.66.0')
    assert.equal(readFileSync(join(dir, 'User', 'config.json'), 'utf8'), '{"mine":true}')
    assert.ok(jobs.some(j => j.id === done?.id && /Mirror酱/.test(j.message ?? '')))
    assert.equal(github.requests.length, 0, 'GitHub was not asked')
    info = library.get('bettergi')
    assert.deepEqual(info.localVersion, { version: '0.66.0', from: '更新' })
  } finally {
    library.dispose()
    await mirror.close()
    await github.close()
  }
})

test('a folder imported before it was recognized gets its channels when the library starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-bgi-old-'))
  const github = await startFakeGitHub({ repos: {} })
  const mirror = await fakeMirror({ rid: 'BGI', latest: '0.66.0', cdk: 'good', full: makeZip({ 'BetterGI.exe': 'MZ' }) })
  const dir = join(root, 'BetterGI')
  mkdirSync(dir)
  writeFileSync(join(dir, 'BetterGI.exe'), 'MZ')
  // The library state an older MultiGameAssistant wrote: imported, nothing known about it.
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(join(root, 'data', 'scripts.json'), JSON.stringify({ version: 1, settings: {}, scripts: [{ id: 'bettergi', name: 'BetterGI', source: { kind: 'local', path: dir }, current: 'local', versions: [{ version: 'local', dir, installedAt: 1 }], addedAt: 1 }] }))
  const { library } = setup(root, { github: github.url, mirror: mirror.url })
  await library.start()
  try {
    assert.equal(library.get('bettergi').channels.mirrorchyan?.rid, 'BGI')
  } finally {
    library.dispose()
    await mirror.close()
    await github.close()
  }
})

test('installed straight from Mirror酱: a CDK is needed to download, checking is not; updates come from there incrementally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-mirror-only-'))
  const github = await startFakeGitHub({ repos: {} })
  const patch = makeZip({ 'tool.exe': 'MZ 1.1.0', 'changes.json': JSON.stringify({ modified: ['tool.exe'], deleted: ['old.txt'] }) })
  const state = { latest: 'v1.0.0', cdk: 'good', full: makeZip({ 'tool.exe': 'MZ 1.0.0', 'old.txt': 'old' }) } as Parameters<typeof fakeMirror>[0]
  const mirror = await fakeMirror(state)
  let cdk: string | undefined
  const { library } = setup(root, { github: github.url, mirror: mirror.url, cdk: () => cdk })
  await library.start()
  try {
    const found = await library.lookupMirror('Tool')
    assert.deepEqual(found, { rid: 'Tool', version: '1.0.0', platform: false, os: false, arch: false }, 'asked with os and arch first, then without')
    await assert.rejects(library.lookupMirror('Nothing'), /没有这个资源/)

    const refused = await library.install({ mirrorchyan: { rid: 'Tool', platform: false } }).done
    assert.equal(refused.phase, 'failed')
    assert.match(refused.error ?? '', /只能从 Mirror酱 下载.*CDK/)

    cdk = 'good'
    const first = await library.install({ mirrorchyan: { rid: 'Tool', platform: false } }).done
    assert.equal(first.phase, 'done', first.error)
    let info = library.get('tool')
    assert.deepEqual(info.source, { kind: 'mirrorchyan', rid: 'Tool', platform: false })
    assert.deepEqual(info.channels, { mirrorchyan: { rid: 'Tool', from: 'install' } })
    assert.equal(info.current, '1.0.0')
    assert.throws(() => library.install({ repo: 'Owner/Tool', id: 'tool' }), /已属于 Mirror酱 Tool/)

    state.latest = 'v1.1.0'
    state.incremental = { from: 'v1.0.0', body: patch }
    cdk = undefined
    assert.deepEqual(await library.checkUpdate('tool'), { current: '1.0.0', latest: '1.1.0', available: true }, 'checked without a CDK')
    cdk = 'good'
    const update = await library.update('tool')
    const done = update.upToDate ? undefined : await update.done
    assert.equal(done?.phase, 'done', done?.error)
    info = library.get('tool')
    assert.equal(info.current, '1.1.0')
    assert.equal(readFileSync(join(info.dir!, 'tool.exe'), 'utf8'), 'MZ 1.1.0')
    assert.ok(!existsSync(join(info.dir!, 'old.txt')))
    assert.equal(github.requests.length, 0)
    await assert.rejects(library.setUpdateSource('tool', { mirrorchyan: null }), /跟随它安装时的资源/)
  } finally {
    library.dispose()
    await mirror.close()
    await github.close()
  }
})

test('any script can be given a Mirror酱 channel; the agent installs from Mirror酱 and asks for resources it does not know', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-mirror-set-'))
  const github = await startFakeGitHub({ repos: {} })
  const mirror = await fakeMirror({ latest: 'v2.0.0', cdk: 'good', full: makeZip({ 'tool.exe': 'MZ 2.0.0' }) })
  const { library } = setup(root, { github: github.url, mirror: mirror.url, cdk: () => 'good' })
  await library.start()
  try {
    const dir = join(root, 'Tool')
    mkdirSync(dir)
    writeFileSync(join(dir, 'tool.exe'), 'MZ 1.0.0')
    writeFileSync(join(dir, 'version.txt'), '1.0.0')
    let info = await library.import({ path: dir })
    assert.deepEqual(info.channels, {})
    info = await library.setUpdateSource(info.id, { mirrorchyan: await library.lookupMirror('Tool') })
    assert.deepEqual(info.channels, { mirrorchyan: { rid: 'Tool', from: 'user' } })
    const update = await library.update(info.id)
    const done = update.upToDate ? undefined : await update.done
    assert.equal(done?.phase, 'done', done?.error)
    assert.equal(readFileSync(join(dir, 'tool.exe'), 'utf8'), 'MZ 2.0.0')
    info = await library.setUpdateSource(info.id, { reset: ['mirrorchyan'] })
    assert.deepEqual(info.channels, {})

    const asked: string[] = []
    const exec = { signal: new AbortController().signal } as never
    const tools = scriptTools(library, async (_exec, reason) => { asked.push(reason) })
    const installed = await tools.find(t => t.name === TOOL_NAMES.install)!.execute({ mirrorchyan: 'Tool', id: 'tool2' }, exec) as { ok: boolean; version: string }
    assert.equal(installed.ok, true)
    assert.equal(installed.version, '2.0.0')
    assert.equal(asked.length, 1)
    assert.match(asked[0]!, /Mirror酱.*Tool.*不在已知列表里/)
  } finally {
    library.dispose()
    await mirror.close()
    await github.close()
  }
})
