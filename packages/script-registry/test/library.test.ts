import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EnvHost } from '@adg/installer'
import type { ScriptJob } from '@adg/protocol'
import { makeZip, startFakeGitHub, type FakeRelease } from '@adg/test-kit'
import { ScriptLibrary } from '../src/library.ts'
import { scriptTools, TOOL_NAMES } from '../src/tools.ts'

const PACK = `id: tool
name: Fake Tool
family: gui-config
source:
  github: Owner/Tool
  release:
    asset: 'Tool-v{version}-win-x64.zip'
install:
  requires:
    - kind: dotnet-desktop-runtime
      version: '>=8'
config:
  files:
    - path: config/*.json
      format: json
detect:
  files: [tool.exe, config]
`

const release = (version: string, day: number, extra: Record<string, string> = {}): FakeRelease => ({
  tag: `v${version}`,
  publishedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`,
  assets: [
    { name: `Tool-v${version}-win-x64.zip`, content: makeZip({ [`Tool-${version}/`]: '', [`Tool-${version}/tool.exe`]: `MZ ${version}`, [`Tool-${version}/config/gui.json`]: '{"default":true}', ...extra }) },
    { name: `Tool-v${version}-linux.tar.gz`, content: 'nope' },
  ],
})

const noDotnet: EnvHost = { exec: async () => undefined, exists: async () => false, listDir: async () => [], env: () => undefined }

async function setup(releases: FakeRelease[]) {
  const root = mkdtempSync(join(tmpdir(), 'adg-lib-'))
  const packs = join(root, 'packs')
  mkdirSync(join(packs, 'tool'), { recursive: true })
  writeFileSync(join(packs, 'tool', 'adg.script.yaml'), PACK)
  mkdirSync(join(packs, 'broken'))
  writeFileSync(join(packs, 'broken', 'adg.script.yaml'), 'id: other\nname: Mismatch\n')
  const github = await startFakeGitHub({ repos: { 'Owner/Tool': releases, 'Stranger/Thing': [{ tag: '1.0', assets: [{ name: 'thing-win64.zip', content: makeZip({ 'thing.exe': 'MZ' }) }] }] } })
  const jobs: ScriptJob[] = []
  const changed: (string | undefined)[] = []
  const library = new ScriptLibrary({
    toolsDir: join(root, 'tools'),
    dataDir: join(root, 'data'),
    packDirs: [packs],
    defaults: { apiBase: github.url, keepVersions: 2 },
    credential: async () => undefined,
    credentialConfigured: async () => false,
    envHost: noDotnet,
    onChanged: id => changed.push(id),
    onJob: job => jobs.push(job),
    log: { info() {}, warn() {} },
  })
  await library.start()
  return { root, github, library, jobs, changed }
}

test('install, update with config carried over, rollback, and pruning to keepVersions', async () => {
  const { root, github, library, jobs } = await setup([release('1.0.0', 1)])
  try {
    const list = library.list()
    assert.deepEqual(list.packs.find(p => p.id === 'tool')?.repo, 'Owner/Tool')
    assert.match(list.packs.find(p => p.id === 'broken')?.error ?? '', /must match its directory name/)

    const first = await library.install({ repo: 'Owner/Tool' }).done
    assert.equal(first.phase, 'done', first.error)
    assert.equal(first.version, '1.0.0')
    const phases = jobs.filter(j => j.id === first.id).map(j => j.phase)
    for (const phase of ['queued', 'resolving', 'downloading', 'extracting', 'checking', 'done']) assert.ok(phases.includes(phase as never), `saw ${phase}`)

    let info = library.get('tool')
    assert.equal(info.current, '1.0.0')
    assert.equal(info.dir, join(root, 'tools', 'tool', '1.0.0'))
    assert.equal(readFileSync(join(info.dir!, 'tool.exe'), 'utf8'), 'MZ 1.0.0', 'the archive root folder was lifted')
    assert.ok(!existsSync(join(root, 'tools', 'tool', '.downloads', 'Tool-v1.0.0-win-x64.zip')), 'the archive is removed after unpacking')
    assert.equal(info.env?.ok, false)
    assert.equal(info.env?.items[0]?.fix?.kind, 'installer')
    assert.equal(info.family, 'gui-config')

    // The user changes a setting; an update must keep it.
    writeFileSync(join(info.dir!, 'config', 'gui.json'), '{"mine":true}')
    assert.deepEqual(await library.update('tool').then(r => r.upToDate), true)

    github.close()
    const next = await startFakeGitHub({ repos: { 'Owner/Tool': [release('1.0.0', 1), release('1.1.0', 2), release('1.2.0', 3)] } })
    await library.setSettings({ apiBase: next.url })
    try {
      const update = await library.update('tool')
      assert.equal(update.upToDate, false)
      const job = update.upToDate ? undefined : await update.done
      assert.equal(job?.phase, 'done', job?.error)
      info = library.get('tool')
      assert.equal(info.current, '1.2.0')
      assert.equal(readFileSync(join(info.dir!, 'config', 'gui.json'), 'utf8'), '{"mine":true}', 'config carried over')
      assert.deepEqual(info.versions.map(v => v.version), ['1.2.0', '1.0.0'])

      const back = await library.rollback('tool')
      assert.equal(back.current, '1.0.0')
      await library.rollback('tool', '1.2.0')

      // Installing 1.1.0 explicitly makes three versions; keepVersions = 2 prunes the oldest.
      const third = await library.install({ repo: 'Owner/Tool', tag: 'v1.1.0' }).done
      assert.equal(third.phase, 'done', third.error)
      info = library.get('tool')
      assert.deepEqual(info.versions.map(v => v.version).sort(), ['1.1.0', '1.2.0'])
      assert.ok(!existsSync(join(root, 'tools', 'tool', '1.0.0')), 'pruned version directory deleted')
      await assert.rejects(library.rollback('tool', '1.0.0'), /没有安装版本 1\.0\.0/)
    } finally {
      await next.close()
    }

    // State survives a restart.
    const reopened = new ScriptLibrary({
      toolsDir: join(root, 'tools'), dataDir: join(root, 'data'), packDirs: [join(root, 'packs')],
      credential: async () => undefined, credentialConfigured: async () => false, envHost: noDotnet,
      onChanged() {}, onJob() {}, log: { info() {}, warn() {} },
    })
    await reopened.start()
    assert.equal(reopened.get('tool').current, '1.1.0')
  } finally {
    await github.close().catch(() => {})
  }
})

test('one job per script, and failures name what was available', async () => {
  const { github, library } = await setup([{ tag: 'v2.0.0', assets: [{ name: 'Tool-v2.0.0-linux.tar.gz', content: 'x' }] }])
  try {
    const failed = await library.install({ repo: 'Owner/Tool' }).done
    assert.equal(failed.phase, 'failed')
    assert.match(failed.error ?? '', /没有文件匹配脚本包规则.*可选文件：Tool-v2\.0\.0-linux\.tar\.gz/)

    github.fault({ kind: 'status', status: 500 }, 1)
    const started = library.install({ repo: 'Owner/Tool' })
    assert.throws(() => library.install({ repo: 'Owner/Tool' }), /正在进行另一个任务/)
    assert.equal((await started.done).phase, 'failed')
  } finally {
    await github.close()
  }
})

test('local import recognizes the pack, never moves files, and remove never deletes them', async () => {
  const { root, github, library } = await setup([])
  try {
    const dir = join(root, 'My Tool')
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'tool.exe'), 'MZ')
    const info = await library.import({ path: dir })
    assert.equal(info.id, 'tool')
    assert.equal(info.packId, 'tool')
    assert.equal(info.source.kind, 'local')
    assert.equal(info.dir, dir)
    assert.ok(info.env !== undefined, 'the pack requirements were checked')
    assert.equal((await library.import({ path: dir })).id, 'tool', 'importing the same directory again returns the same entry')

    const other = join(root, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'run.bat'), '@echo off')
    const plain = await library.import({ path: other })
    assert.equal(plain.id, 'other')
    assert.equal(plain.packId, undefined)
    assert.deepEqual(plain.probe?.executables, ['run.bat'])

    assert.throws(() => library.install({ repo: 'Owner/Tool' }), /已被本地导入/)
    await assert.rejects(library.rollback('tool'), /无法回滚/)
    await assert.rejects(library.import({ path: join(root, 'missing') }), /不是一个存在的目录/)

    await library.remove('tool', true)
    assert.ok(existsSync(join(dir, 'tool.exe')), 'an imported directory is never deleted')
    assert.equal(library.list().scripts.some(s => s.id === 'tool'), false)
  } finally {
    await github.close()
  }
})

test('the install tool asks for approval only for repositories no built-in pack describes', async () => {
  const { github, library } = await setup([release('1.0.0', 1)])
  try {
    const asked: string[] = []
    const tools = scriptTools(library, async (_exec, reason) => { asked.push(reason) })
    const install = tools.find(t => t.name === TOOL_NAMES.install)!
    const exec = { signal: new AbortController().signal } as never

    const curated = await install.execute({ repo: 'Owner/Tool' }, exec) as { ok: boolean; version: string }
    assert.equal(curated.ok, true)
    assert.equal(asked.length, 0)

    const stranger = await install.execute({ repo: 'Stranger/Thing' }, exec) as { ok: boolean; script: string }
    assert.equal(stranger.ok, true)
    assert.equal(stranger.script, 'thing')
    assert.equal(asked.length, 1)
    assert.match(asked[0]!, /Stranger\/Thing/)

    const refusing = scriptTools(library, async () => { throw new Error('用户拒绝了这个操作') })
    await assert.rejects(refusing.find(t => t.name === TOOL_NAMES.install)!.execute({ repo: 'Stranger/Thing', id: 'thing2' }, exec), /用户拒绝/)
    assert.equal(library.list().scripts.some(s => s.id === 'thing2'), false)
  } finally {
    await github.close()
  }
})
