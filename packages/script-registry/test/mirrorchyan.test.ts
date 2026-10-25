import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyMirrorChanges, mirrorLatest, MirrorChyanError, type EnvHost } from '@adg/installer'
import type { ScriptJob } from '@adg/protocol'
import { makeZip, startFakeGitHub } from '@adg/test-kit'
import { ScriptLibrary } from '../src/library.ts'
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
    - path: config/*.json
      format: json
`

const noDotnet: EnvHost = { exec: async () => undefined, exists: async () => false, listDir: async () => [], env: () => undefined }

test('the Mirror酱 client: versions, links only with a CDK, CDK errors as such, the platform asked only when uploaded per platform', async () => {
  const mirror = await fakeMirror({ latest: 'v1.0.0', cdk: 'good', full: makeZip({ 'tool.exe': 'MZ' }) })
  try {
    const resource = { rid: 'Tool', platform: false }
    const free = await mirrorLatest(resource, { base: mirror.url })
    assert.deepEqual(free, { version: 'v1.0.0' }, 'no CDK: the version only')
    const paid = await mirrorLatest(resource, { base: mirror.url, cdk: 'good' })
    assert.match(paid.url ?? '', /\/dl\/full\.zip$/)
    assert.equal(paid.updateType, 'full')
    assert.equal(paid.cdkExpiresAt, 1824382315000)
    await assert.rejects(mirrorLatest(resource, { base: mirror.url, cdk: 'bad' }), (e: unknown) => e instanceof MirrorChyanError && e.aboutCdk && /CDK 不对/.test(e.message))
    await assert.rejects(mirrorLatest({ rid: 'Tool', platform: true }, { base: mirror.url }), /没有这个资源/)
    assert.equal(mirror.asked.at(-1)?.get('os'), 'windows')
    assert.equal(mirror.asked[0]?.get('user_agent'), 'MultiGameAssistant')
    await assert.rejects(mirrorLatest(resource, { base: 'http://127.0.0.1:1' }), /连不上 Mirror酱/)
  } finally {
    await mirror.close()
  }
})

test('changes.json: what went away is deleted, nothing outside the folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-changes-'))
  mkdirSync(join(dir, 'old', 'deep'), { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'a')
  writeFileSync(join(dir, 'old', 'deep', 'b.txt'), 'b')
  writeFileSync(join(dir, 'changes.json'), JSON.stringify({ deleted: ['Tool/a.txt'], deleted_dir: ['Tool/old'], added: ['Tool/c.txt'] }))
  assert.equal(await applyMirrorChanges(dir, 'Tool'), 2)
  assert.ok(!existsSync(join(dir, 'a.txt')) && !existsSync(join(dir, 'old')) && !existsSync(join(dir, 'changes.json')))
  writeFileSync(join(dir, 'changes.json'), JSON.stringify({ deleted: ['../outside.txt'] }))
  await assert.rejects(applyMirrorChanges(dir), /不在安装目录里/)
  assert.equal(await applyMirrorChanges(mkdtempSync(join(tmpdir(), 'adg-nochanges-'))), 0, 'a full package has no changes.json')
})

test('with a CDK: installed from Mirror酱, updated with only the changed files keeping the config; a bad CDK falls back to GitHub', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-mirror-'))
  mkdirSync(join(root, 'packs', 'tool'), { recursive: true })
  writeFileSync(join(root, 'packs', 'tool', 'adg.script.yaml'), PACK)
  const full = makeZip({ 'Tool-1.0.0/': '', 'Tool-1.0.0/tool.exe': 'MZ 1.0.0', 'Tool-1.0.0/old.txt': 'old', 'Tool-1.0.0/config/gui.json': '{"default":true}', 'Tool-1.0.0/data/keep.bin': 'k' })
  // Built from the uploaded zips, so its paths keep the top folder the install lifted off.
  const patch = makeZip({ 'Tool-1.0.0/tool.exe': 'MZ 1.1.0', 'Tool-1.0.0/new.dll': 'MZ', 'changes.json': JSON.stringify({ modified: ['Tool-1.0.0/tool.exe'], added: ['Tool-1.0.0/new.dll'], deleted: ['Tool-1.0.0/old.txt'] }) })
  const state = { latest: 'v1.0.0', cdk: 'good', full } as Parameters<typeof fakeMirror>[0]
  const mirror = await fakeMirror(state)
  const github = await startFakeGitHub({ repos: { 'Owner/Tool': [{ tag: 'v1.2.0', assets: [{ name: 'Tool-v1.2.0-win-x64.zip', content: makeZip({ 'tool.exe': 'MZ 1.2.0 from GitHub' }) }] }] } })
  let cdk = 'good'
  const jobs: ScriptJob[] = []
  const library = new ScriptLibrary({
    toolsDir: join(root, 'tools'), dataDir: join(root, 'data'), packDirs: [join(root, 'packs')],
    defaults: { apiBase: github.url },
    credential: async ref => (ref === 'MIRRORCHYAN_CDK' ? cdk : undefined),
    credentialConfigured: async ref => ref === 'MIRRORCHYAN_CDK',
    envHost: noDotnet, mirrorchyanBase: mirror.url,
    onChanged() {}, onJob: job => jobs.push(job), log: { info() {}, warn() {} },
  })
  await library.start()
  try {
    const first = await library.install({ repo: 'Owner/Tool' }).done
    assert.equal(first.phase, 'done', first.error)
    let info = library.get('tool')
    assert.equal(info.current, '1.0.0')
    assert.equal(info.mirrorchyan, 'Tool')
    assert.equal(readFileSync(join(info.dir!, 'tool.exe'), 'utf8'), 'MZ 1.0.0')
    assert.match(info.versions[0]!.asset?.name ?? '', /Mirror酱 完整包/)
    assert.ok(jobs.some(j => j.id === first.id && j.phase === 'downloading' && /Mirror酱/.test(j.message ?? '')))
    assert.equal(github.requests.length, 0, 'GitHub was not asked')
    writeFileSync(join(info.dir!, 'config', 'gui.json'), '{"mine":true}')
    assert.deepEqual(await library.checkMirrorCdk(), { ok: true, message: `CDK 可用，到 ${new Date(1824382315000).toLocaleDateString('zh-CN')} 到期`, expiresAt: 1824382315000 })

    state.latest = 'v1.1.0'
    state.incremental = { from: 'v1.0.0', body: patch }
    assert.deepEqual(await library.checkUpdate('tool'), { current: '1.0.0', latest: '1.1.0', available: true })
    const update = await library.update('tool')
    const done = update.upToDate ? undefined : await update.done
    assert.equal(done?.phase, 'done', done?.error)
    info = library.get('tool')
    assert.equal(info.current, '1.1.0')
    assert.equal(readFileSync(join(info.dir!, 'tool.exe'), 'utf8'), 'MZ 1.1.0', 'changed file replaced')
    assert.ok(existsSync(join(info.dir!, 'new.dll')), 'added file')
    assert.ok(existsSync(join(info.dir!, 'data', 'keep.bin')), 'unchanged files come from the installed version')
    assert.ok(!existsSync(join(info.dir!, 'old.txt')), 'deleted file removed')
    assert.ok(!existsSync(join(info.dir!, 'changes.json')))
    assert.equal(readFileSync(join(info.dir!, 'config', 'gui.json'), 'utf8'), '{"mine":true}', 'the user config kept')
    assert.ok(existsSync(join(root, 'tools', 'tool', '1.0.0', 'old.txt')), 'the previous version is untouched, for rollback')
    assert.match(info.versions.find(v => v.version === '1.1.0')?.asset?.name ?? '', /增量包/)
    assert.equal(mirror.asked.at(-1)?.get('current_version'), 'v1.0.0')

    // A wrong CDK: said so, and the update comes from GitHub instead.
    cdk = 'bad'
    state.latest = 'v1.2.0'
    const fallback = await library.update('tool')
    const fell = fallback.upToDate ? undefined : await fallback.done
    assert.equal(fell?.phase, 'done', fell?.error)
    assert.equal(library.get('tool').current, '1.2.0')
    assert.ok(jobs.some(j => j.id === fell?.id && /CDK 不对.*改从 GitHub 下载/.test(j.message ?? '')))
    assert.equal((await library.checkMirrorCdk()).ok, false)
  } finally {
    library.dispose()
    await mirror.close()
    await github.close()
  }
})
