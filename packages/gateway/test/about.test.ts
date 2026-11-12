import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { aboutCapability, cleanNotes, compareVersions, newestRelease, pluginVersion, releaseNotes } from '../src/about.ts'
import type { MethodContext } from '../src/registry.ts'

const call = { signal: new AbortController().signal } as MethodContext
const manifest = (pkg: object) => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-about-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  return pathToFileURL(join(dir, 'package.json'))
}
const asset = { name: 'dsh-multigameassistant.tgz' }
const release = (tag: string, extra: object = {}) => ({ tag_name: tag, html_url: `https://github.com/x/releases/tag/${tag}`, assets: [asset], ...extra })

test('the version is the plugin package\'s; a checkout\'s gateway, or the package before a release, is not the plugin', () => {
  assert.equal(pluginVersion(manifest({ name: 'dsh-multigameassistant', version: '2.0.2' })), '2.0.2')
  assert.equal(pluginVersion(manifest({ name: 'dsh-multigameassistant', version: '0.0.0-source' })), undefined)
  assert.equal(pluginVersion(manifest({ name: '@adg/gateway', version: '0.1.0' })), undefined)
  assert.equal(pluginVersion(new URL('file:///nowhere/package.json')), undefined)
  assert.equal(pluginVersion(), undefined, 'this checkout')
})

test('versions in release order', () => {
  assert.equal(compareVersions('2.0.2', '2.0.1'), 1)
  assert.equal(compareVersions('v2.0.2', '2.0.2'), 0)
  assert.equal(compareVersions('2.1.0-rc.1', '2.1.0'), -1)
  assert.equal(compareVersions('2.1.0-rc.10', '2.1.0-rc.2'), 1)
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1)
})

test('the newest release with the plugin package; pre-releases only for a pre-release', () => {
  const releases = [release('v2.1.0-rc.1', { prerelease: true }), release('v2.0.3'), release('v2.0.4', { draft: true }), release('v2.0.5', { assets: [] }), release('v2.0.2')]
  assert.deepEqual(newestRelease(releases, '2.0.2'), { version: '2.0.3', prerelease: false, notesUrl: 'https://github.com/x/releases/tag/v2.0.3' })
  assert.equal(newestRelease(releases, '2.1.0-rc.1')?.version, undefined, 'already on the newest')
  assert.equal(newestRelease(releases, '2.0.3'), undefined)
  assert.equal(newestRelease([release('v2.1.0-rc.2', { prerelease: true })], '2.1.0-rc.1')?.version, '2.1.0-rc.2')
})

const fakeFetch = (routes: Record<string, unknown>) => (async (url: string | URL | Request) => {
  const body = routes[String(url).split('?')[0]!]
  if (body instanceof Error) throw body
  return body === undefined ? new Response('', { status: 404 }) : Response.json(body)
}) as typeof fetch
const GITHUB = 'https://api.github.com/repos/haaahhhis/MultiGameAssistant/releases'
const NPM = 'https://registry.npmjs.org/dsh-multigameassistant'
const handler = (name: string, deps: Parameters<typeof aboutCapability>[0]) => aboutCapability({ now: () => 5, ...deps }).methods[name]!

test('about/info: the plugin with its version, or another build', async () => {
  assert.deepEqual(await handler('about/info', { version: () => '2.0.2' })({}, call), { edition: 'plugin', version: '2.0.2' })
  assert.deepEqual(await handler('about/info', { version: () => undefined })({}, call), { edition: 'other' })
})

test('about/checkUpdate: a newer release, and whether npm serves it yet', async () => {
  const check = (npm: unknown) => handler('about/checkUpdate', { version: () => '2.0.2', fetch: fakeFetch({ [GITHUB]: [release('v2.0.3'), release('v2.0.2')], [NPM]: npm }) })({}, call)
  assert.deepEqual(await check({ 'dist-tags': { latest: '2.0.3' } }), { current: '2.0.2', latest: { version: '2.0.3', prerelease: false, notesUrl: 'https://github.com/x/releases/tag/v2.0.3', onNpm: true, notes: [{ version: '2.0.3', url: 'https://github.com/x/releases/tag/v2.0.3', body: '' }] }, checkedAt: 5 })
  assert.equal(((await check({ 'dist-tags': { latest: '2.0.2' } })) as { latest: { onNpm: boolean } }).latest.onNpm, false, 'waiting for approval')
  assert.equal(((await check(new Error('offline'))) as { latest: { onNpm?: boolean } }).latest.onNpm, undefined, 'npm unknown')
  assert.deepEqual(await handler('about/checkUpdate', { version: () => '2.0.3', fetch: fakeFetch({ [GITHUB]: [release('v2.0.3')] }) })({}, call), { current: '2.0.3', checkedAt: 5 })
})

test("the release notes are each newer release's GitHub text, without the download list", () => {
  const body = '## 新功能\r\n\r\n- **复制、粘贴**：Ctrl+C\r\n<!-- 草稿说明 -->\r\n## 修复\r\n\r\n- 修好了\r\n\r\n## 下载\r\n\r\n- Windows x64：`a.exe`\r\n'
  assert.equal(cleanNotes(body), '## 新功能\n\n- **复制、粘贴**：Ctrl+C\n\n## 修复\n\n- 修好了')
  assert.equal(cleanNotes(undefined), '')
  assert.match(cleanNotes('x'.repeat(9000)), /……（更多见发布页）$/)
  const releases = [release('v2.1.0-rc.1', { prerelease: true }), release('v2.0.4', { body: '四', name: 'v2.0.4', published_at: '2026-11-12T00:00:00Z' }), release('v2.0.3', { body: '三' }), release('v2.0.5', { draft: true }), release('v2.0.2', { body: '二' })]
  assert.deepEqual(releaseNotes(releases, '2.0.2', '2.0.4').map(n => [n.version, n.body]), [['2.0.4', '四'], ['2.0.3', '三']], 'newest first, from after this one up to the offered one')
  assert.equal(releaseNotes(releases, '2.0.2', '2.0.4')[0]!.publishedAt, '2026-11-12T00:00:00Z')
  assert.deepEqual(releaseNotes(releases, '2.0.4', '2.1.0-rc.1').map(n => n.version), [], 'a stable version is not told about pre-releases')
})

test('about/checkUpdate: says why when it cannot', async () => {
  await assert.rejects(async () => handler('about/checkUpdate', { version: () => undefined })({}, call), /只有 dsh 插件版/)
  await assert.rejects(async () => handler('about/checkUpdate', { version: () => '2.0.2', fetch: fakeFetch({ [GITHUB]: new Error('ECONNRESET') }) })({}, call), /连不上 GitHub.*ECONNRESET/)
  await assert.rejects(async () => handler('about/checkUpdate', { version: () => '2.0.2', fetch: fakeFetch({}) })({}, call), /api\.github\.com 返回 404/)
})
