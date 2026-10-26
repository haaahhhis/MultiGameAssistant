import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assetSha256, compareVersions, createUpdater, pickRelease } from '../../apps/desktop/updates.mjs'

test('versions order by semantic versioning, pre-releases before their release', () => {
  const sorted = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-rc.2', '1.0.0-rc.10', '1.0.0', '1.0.1', '1.1.0', '2.0.0']
  for (let i = 0; i < sorted.length - 1; i++) {
    assert.equal(compareVersions(sorted[i], sorted[i + 1]), -1, `${sorted[i]} < ${sorted[i + 1]}`)
    assert.equal(compareVersions(sorted[i + 1], sorted[i]), 1, `${sorted[i + 1]} > ${sorted[i]}`)
  }
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.2', '1.2.0'), 0)
})

const DIGEST = `sha256:${'0'.repeat(64)}`
const release = (version, { prerelease = /-/.test(version), arm64 = true, digest = true, draft = false } = {}) => ({
  tag_name: `v${version}`,
  prerelease,
  draft,
  html_url: `https://example.test/releases/v${version}`,
  assets: [
    { name: `MultiGameAssistant-Setup-${version}.exe`, size: 10, browser_download_url: `x64/${version}`, ...(digest ? { digest: DIGEST } : {}) },
    ...(arm64 ? [{ name: `MultiGameAssistant-Setup-${version}-arm64.exe`, size: 10, browser_download_url: `arm64/${version}`, digest: DIGEST }] : []),
  ],
})

test('a stable version is offered stable releases only; a pre-release newer pre-releases too', () => {
  const releases = [release('1.2.0-rc.1'), release('1.1.0'), release('1.0.0'), release('1.0.0-rc.3')]
  assert.equal(pickRelease(releases, '1.0.0', 'x64')?.version, '1.1.0')
  assert.equal(pickRelease(releases, '1.0.0-rc.3', 'x64')?.version, '1.2.0-rc.1')
  assert.equal(pickRelease(releases, '1.1.0', 'x64'), undefined)
  assert.equal(pickRelease(releases, '1.2.0-rc.1', 'x64'), undefined)
})

test('a release without this architecture\'s installer or its SHA-256, or a draft, is not offered', () => {
  assert.equal(pickRelease([release('1.1.0', { arm64: false })], '1.0.0', 'arm64'), undefined)
  assert.equal(pickRelease([release('1.1.0', { arm64: false })], '1.0.0', 'x64')?.version, '1.1.0')
  assert.equal(pickRelease([release('1.1.0', { digest: false })], '1.0.0', 'x64'), undefined)
  assert.equal(pickRelease([release('1.1.0', { draft: true })], '1.0.0', 'x64'), undefined)
})

test('the SHA-256 is read from GitHub\'s digest', () => {
  assert.equal(assetSha256({ digest: `sha256:${'AB'.repeat(32)}` }), 'ab'.repeat(32))
  assert.equal(assetSha256({ digest: `sha512:${'a'.repeat(128)}` }), undefined)
  assert.equal(assetSha256({}), undefined)
})

/** GitHub's releases list and downloads, from a local server. */
async function fakeGitHub(installer, { corrupt = false, status = 200 } = {}) {
  const hash = createHash('sha256').update(installer).digest('hex')
  const name = 'MultiGameAssistant-Setup-1.1.0.exe'
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`
    if (req.url === '/releases') {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status !== 200 ? '{}' : JSON.stringify([{
        tag_name: 'v1.1.0', prerelease: false, draft: false, html_url: `${base}/notes`, published_at: '2026-10-26T00:00:00Z',
        assets: [{ name, size: installer.length, browser_download_url: `${base}/download/${name}`, digest: `sha256:${hash}` }],
      }]))
    } else if (req.url === `/download/${name}`) {
      res.end(corrupt ? Buffer.concat([installer, Buffer.from('x')]) : installer)
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { api: `http://127.0.0.1:${server.address().port}/releases`, close: () => server.close(), name }
}

test('a newer release is found, downloaded and checked against its SHA-256', async () => {
  const installer = Buffer.alloc(200_000, 7)
  const github = await fakeGitHub(installer)
  const dir = mkdtempSync(join(tmpdir(), 'adg-update-'))
  writeFileSync(join(dir, 'MultiGameAssistant-Setup-1.0.5.exe'), 'an older download')
  const found = []
  const states = []
  try {
    const updater = createUpdater({ current: '1.0.0', arch: 'x64', dir, api: github.api, onChange: s => states.push(s), onFound: v => found.push(v) })
    assert.throws(() => updater.installCommand(), /还没有下载好/)
    const checked = await updater.check({ automatic: true })
    assert.equal(checked.latest?.version, '1.1.0')
    assert.equal(checked.error, undefined)
    await updater.check({ automatic: true })
    assert.deepEqual(found, ['1.1.0'], 'announced once')

    const done = await updater.download()
    assert.equal(done.download?.state, 'ready', done.download?.error)
    const { file, args } = updater.installCommand()
    assert.deepEqual(readFileSync(file), installer)
    assert.deepEqual(args, ['/S', '--updated', '--force-run'])
    assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.exe')), [github.name], 'older downloads removed')
    assert.ok(states.some(s => s.download?.state === 'downloading'))
  } finally {
    github.close()
  }
})

test('a download that does not match its SHA-256 is deleted, not offered for installing', async () => {
  const github = await fakeGitHub(Buffer.alloc(1000, 1), { corrupt: true })
  const dir = mkdtempSync(join(tmpdir(), 'adg-update-'))
  try {
    const updater = createUpdater({ current: '1.0.0', arch: 'x64', dir, api: github.api, onChange: () => {} })
    await updater.check()
    const result = await updater.download()
    assert.equal(result.download?.state, 'failed')
    assert.match(result.download?.error ?? '', /SHA-256/)
    assert.equal(readdirSync(dir).some(n => n.endsWith('.exe') || n.endsWith('.part')), false)
    assert.throws(() => updater.installCommand())
  } finally {
    github.close()
  }
})

test('a private or missing repository says so; skipped versions and the auto setting are remembered', async () => {
  const github = await fakeGitHub(Buffer.alloc(10), { status: 404 })
  const dir = mkdtempSync(join(tmpdir(), 'adg-update-'))
  try {
    const updater = createUpdater({ current: '1.0.0', arch: 'x64', dir, api: github.api, onChange: () => {} })
    assert.match((await updater.check()).error ?? '', /私有/)
    updater.skip('1.1.0')
    updater.setAuto(false)
    assert.ok(existsSync(join(dir, 'update.json')))
    const again = createUpdater({ current: '1.0.0', arch: 'x64', dir, api: github.api, onChange: () => {} })
    assert.equal(again.state().skipped, '1.1.0')
    assert.equal(again.state().auto, false)
  } finally {
    github.close()
  }
})
