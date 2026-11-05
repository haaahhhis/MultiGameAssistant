import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ScriptInfo } from '@adg/protocol'
import { makeZip, startFakeGitHub, type FakeRelease } from '@adg/test-kit'
import { OPTIMIZE_AFTER_RUNS, ScriptLibrary } from '../src/library.ts'

const PACK = `id: tool
name: Fake Tool
family: generic-process
source:
  github: Owner/Tool
  release:
    asset: 'Tool-v{version}-win-x64.zip'
detect:
  files: [tool.exe]
`

const release = (version: string, day: number, body?: string): FakeRelease => ({
  tag: `v${version}`,
  publishedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`,
  ...(body === undefined ? {} : { body }),
  assets: [{ name: `Tool-v${version}-win-x64.zip`, content: makeZip({ 'tool.exe': `MZ ${version}`, 'CHANGELOG.md': `# ${version}\n- notes in the folder` }) }],
})

test('a user pack: an update past its version asks once, the changelog covers the versions since, and checking it clears the ask', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-review-'))
  // In the user's pack folder: not built in, so updates ask about it.
  mkdirSync(join(root, 'data', 'packs', 'tool'), { recursive: true })
  writeFileSync(join(root, 'data', 'packs', 'tool', 'adg.script.yaml'), PACK)
  const first = await startFakeGitHub({ repos: { 'Owner/Tool': [release('1.0.0', 1, 'first')] } })
  const asked: ScriptInfo[] = []
  const library = new ScriptLibrary({
    toolsDir: join(root, 'tools'),
    dataDir: join(root, 'data'),
    packDirs: [],
    defaults: { apiBase: first.url },
    credential: async () => undefined,
    credentialConfigured: async () => false,
    envHost: { exec: async () => undefined, exists: async () => false, listDir: async () => [], env: () => undefined },
    onChanged: () => {},
    onJob: () => {},
    onPackReview: script => asked.push(script),
    log: { info() {}, warn() {} },
  })
  await library.start()
  const next = await startFakeGitHub({ repos: { 'Owner/Tool': [release('1.0.0', 1, 'first'), release('1.1.0', 2, '- 新增任务「活动」'), release('1.2.0', 3, '- 日志改成「全部完成」'), release('1.3.0', 4, 'not installed yet')] } })
  try {
    const installed = await library.install({ repo: 'Owner/Tool' }).done
    assert.equal(installed.phase, 'done', installed.error)
    assert.equal(library.get('tool').packId, 'tool')
    assert.equal(library.get('tool').packReview, undefined, 'the pack counts as written for the version first installed')
    assert.equal(asked.length, 0)

    first.close()
    await library.setSettings({ apiBase: next.url })
    const update = await library.install({ repo: 'Owner/Tool', tag: 'v1.2.0' }).done
    assert.equal(update.phase, 'done', update.error)
    assert.deepEqual(library.get('tool').packReview, { from: '1.0.0', to: '1.2.0' })
    assert.equal(asked.length, 1, 'asked once')
    await library.packReviewed('tool').then(() => library.rollback('tool', '1.0.0')).then(() => library.rollback('tool', '1.2.0'))
    assert.equal(asked.length, 1, 'not asked again for a version already settled')

    const log = await library.changelog('tool', { from: '1.0.0' })
    assert.deepEqual(log.releases.map(r => r.version), ['1.2.0', '1.1.0'], 'the releases after the pack’s version up to the installed one')
    assert.match(log.releases[1]!.notes, /新增任务/)
    assert.deepEqual(log.files.map(f => f.file), ['CHANGELOG.md'])

    assert.equal(library.get('tool').packReview, undefined, 'checked against 1.2.0')
  } finally {
    next.close()
  }
})

test('优化脚本 is offered once after enough clean runs, and once after it went through on a new version; deciding starts counting again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-optimize-'))
  mkdirSync(join(root, 'data', 'packs', 'tool'), { recursive: true })
  writeFileSync(join(root, 'data', 'packs', 'tool', 'adg.script.yaml'), PACK)
  const github = await startFakeGitHub({ repos: { 'Owner/Tool': [release('1.0.0', 1), release('1.1.0', 2)] } })
  const offered: ScriptInfo[] = []
  const library = new ScriptLibrary({
    toolsDir: join(root, 'tools'),
    dataDir: join(root, 'data'),
    packDirs: [],
    defaults: { apiBase: github.url },
    credential: async () => undefined,
    credentialConfigured: async () => false,
    envHost: { exec: async () => undefined, exists: async () => false, listDir: async () => [], env: () => undefined },
    onChanged: () => {},
    onJob: () => {},
    onOptimize: script => offered.push(script),
    log: { info() {}, warn() {} },
  })
  await library.start()
  try {
    assert.equal((await library.install({ repo: 'Owner/Tool', tag: 'v1.0.0' }).done).phase, 'done')
    for (let i = 0; i < OPTIMIZE_AFTER_RUNS - 1; i++) await library.ranClean('tool')
    assert.deepEqual(library.get('tool').optimize, { runs: OPTIMIZE_AFTER_RUNS - 1 })
    assert.equal(offered.length, 0)
    await library.ranClean('tool')
    assert.equal(offered.length, 1)
    assert.equal(offered[0]!.optimize?.due, 'runs')
    await library.ranClean('tool')
    assert.equal(offered.length, 1, 'asked once for this stretch')

    await library.optimizeDone('tool', 'keep')
    assert.deepEqual(library.get('tool').optimize, { runs: 0 }, 'turned down: counting again, not optimized')

    // A user pack is checked first after an update (packReview); optimizing waits for that.
    assert.equal((await library.install({ repo: 'Owner/Tool', tag: 'v1.1.0' }).done).phase, 'done')
    await library.ranClean('tool')
    assert.equal(offered.length, 1, 'not while its pack waits to be checked')
    await library.packReviewed('tool')
    await library.ranClean('tool')
    assert.equal(offered.length, 2)
    assert.equal(offered[1]!.optimize?.due, 'updated')

    const done = await library.optimizeDone('tool', 'run', 1234)
    assert.deepEqual(done.optimize, { runs: 0, at: 1234 })
  } finally {
    github.close()
  }
})
