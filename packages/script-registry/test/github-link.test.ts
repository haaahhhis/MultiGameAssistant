import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EnvHost } from '@adg/installer'
import { makeZip, startFakeGitHub, type FakeGitHubOptions, type FakeSource } from '@adg/test-kit'
import { ScriptLibrary } from '../src/library.ts'
import { scriptTools, TOOL_NAMES } from '../src/tools.ts'

const noDotnet: EnvHost = { exec: async () => undefined, exists: async () => false, listDir: async () => [], env: () => undefined }

async function setup(options: FakeGitHubOptions) {
  const root = mkdtempSync(join(tmpdir(), 'adg-link-'))
  const github = await startFakeGitHub(options)
  const library = new ScriptLibrary({
    toolsDir: join(root, 'tools'),
    dataDir: join(root, 'data'),
    packDirs: [],
    defaults: { apiBase: github.url, keepVersions: 3 },
    credential: async () => undefined,
    credentialConfigured: async () => false,
    envHost: noDotnet,
    onChanged() {},
    onJob() {},
    log: { info() {}, warn() {} },
  })
  await library.start()
  const asked: string[] = []
  const tools = scriptTools(library, async (_exec, reason) => { asked.push(reason) })
  const install = tools.find(t => t.name === TOOL_NAMES.install)!
  const exec = { signal: new AbortController().signal } as never
  return { github, library, asked, install: (args: Record<string, unknown>) => install.execute(args, exec) as Promise<Record<string, unknown>> }
}

test('a repository without releases installs its default branch and follows it', async () => {
  const source: FakeSource = {
    defaultBranch: 'master', stars: 42,
    refs: { master: { sha: 'aaaaaaa1111', date: '2026-10-05T08:00:00Z', files: { 'main.py': 'v1', 'README.md': '# Solo' } } },
  }
  const { github, library, asked, install } = await setup({ repos: {}, sources: { 'Solo/Src': source } })
  try {
    const result = await install({ url: 'https://github.com/Solo/Src' })
    assert.equal(result.ok, true, String(result.error))
    assert.equal(result.version, '2026.10.5-aaaaaaa')
    assert.match(String(result.next), /script-analysis/, 'no pack yet: the agent is led into the analysis')
    assert.match(asked[0]!, /Solo\/Src/)
    assert.match(asked[0]!, /42 星/, 'the approval says what the repository is')
    const info = library.get(String(result.script))
    assert.equal(readFileSync(join(info.dir!, 'main.py'), 'utf8'), 'v1', 'the zip root folder was lifted')

    assert.equal((await library.checkUpdate(info.id)).available, false)
    // A later commit the same day is still the update.
    source.refs.master = { sha: 'bbbbbbb2222', date: '2026-10-05T09:00:00Z', files: { 'main.py': 'v2' } }
    const check = await library.checkUpdate(info.id)
    assert.deepEqual([check.available, check.latest], [true, '2026.10.5-bbbbbbb'])
    const update = await library.update(info.id)
    const job = update.upToDate ? undefined : await update.done
    assert.equal(job?.phase, 'done', job?.error)
    assert.equal(readFileSync(join(library.get(info.id).dir!, 'main.py'), 'utf8'), 'v2')
  } finally {
    await github.close()
  }
})

test('a branch link installs that branch; a release file link installs that file', async () => {
  const { github, library, install } = await setup({
    repos: {
      'Owner/Multi': [{
        tag: 'v2.0', publishedAt: '2026-10-01T00:00:00Z',
        assets: [
          { name: 'Multi-v2.0-win-x64-cpu.zip', content: makeZip({ 'cpu.exe': 'MZ' }) },
          { name: 'Multi-v2.0-win-x64-gpu.zip', content: makeZip({ 'gpu.exe': 'MZ' }) },
        ],
      }],
    },
    sources: { 'Owner/Multi': { refs: { dev: { sha: 'ccccccc3333', date: '2026-10-07T00:00:00Z', files: { 'dev.txt': 'dev' } } } } },
  })
  try {
    // Two files fit equally: the agent is told to ask instead of a guess.
    const guess = await install({ repo: 'Owner/Multi', id: 'multi' })
    assert.equal(guess.ok, false)
    assert.match(String(guess.error), /cpu\.zip、.*gpu\.zip[\s\S]*先问用户/)

    const file = await install({ url: 'https://ghproxy.net/https://github.com/Owner/Multi/releases/download/v2.0/Multi-v2.0-win-x64-gpu.zip', id: 'multi' })
    assert.equal(file.ok, true, String(file.error))
    assert.equal(library.get('multi').versions[0]?.asset?.name, 'Multi-v2.0-win-x64-gpu.zip')

    const branch = await install({ url: 'https://github.com/Owner/Multi/tree/dev', id: 'multi-dev' })
    assert.equal(branch.ok, true, String(branch.error))
    assert.equal(branch.version, '2026.10.7-ccccccc')
    assert.equal(readFileSync(join(library.get('multi-dev').dir!, 'dev.txt'), 'utf8'), 'dev')

    await assert.rejects(install({ url: 'https://gitee.com/someone/thing' }), /script_import/)
  } finally {
    await github.close()
  }
})

test('a repository with only pre-releases says how to install one', async () => {
  const { github, install } = await setup({
    repos: { 'Owner/Beta': [{ tag: 'v0.9-beta', prerelease: true, assets: [{ name: 'beta-win64.zip', content: makeZip({ 'b.exe': 'MZ' }) }] }] },
  })
  try {
    const result = await install({ repo: 'Owner/Beta' })
    assert.equal(result.ok, false)
    assert.match(String(result.error), /只有预发布版本/)
  } finally {
    await github.close()
  }
})
