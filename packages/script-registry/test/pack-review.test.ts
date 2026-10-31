import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ScriptInfo } from '@adg/protocol'
import { makeZip, startFakeGitHub, type FakeRelease } from '@adg/test-kit'
import { ScriptLibrary } from '../src/library.ts'

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
