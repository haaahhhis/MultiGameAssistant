import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { mirrorLatest, windowsResource, type EnvHost } from '@adg/installer'
import { ScriptLibrary } from '../src/library.ts'

const noHost: EnvHost = { exec: async () => undefined, exists: async () => false, listDir: async () => [], env: () => undefined }

/** Mirror酱's project list as its website serves it, trimmed to a few. */
const PROJECTS = [
  { type_id: 'GameTools', resource: 'BGI', name: 'BetterGI', desc: 'BetterGI · 更好的原神， 一个基于计算机视觉技术，意图让原神变的更好的项目。', url: 'https://bettergi.com/', support: ['stable-any-any', 'alpha-windows-x64'], download: true },
  { type_id: 'GameTools', resource: 'okgi', name: '原神 ok-gi', desc: '原神 OKGI 自动拾取 | 后台自动剧情', url: 'https://github.com/ok-oldking/ok-genshin-impact', support: ['stable-any-any'], download: true },
  { type_id: 'GameTools', resource: 'okww', name: '鸣潮 ok-ww', desc: '鸣潮 后台自动战斗 自动刷声骸 一键日常', url: 'https://ok-script.com/ok-ww/', support: ['stable-any-any'], download: true },
  { type_id: 'GameTools', resource: 'ZZZ-OneDragon', name: '绝区零 一条龙', desc: '绝区零 一条龙 | 全自动 | 自动闪避', url: 'https://one-dragon.com/zzz/zh/home.html', support: ['stable-any-x64', 'stable-any-arm64'], download: true },
  { type_id: 'GameTools', resource: 'MaaNTE', name: 'MaaNTE', desc: '😊MAA异环小助手😊', url: 'https://github.com/1bananachicken/MaaNTE', support: ['stable-win-x64'], download: true },
  { type_id: 'GameTools', resource: 'ReveriePaint', name: 'ReveriePaint', desc: 'Android 原生数字绘画应用', url: 'https://example.com/', support: ['stable-android-any'], download: true },
  { type_id: 'Dependencies', resource: 'MFAAvalonia', name: 'MFAAvalonia', desc: '基于 Avalonia 的 MAAFramework 通用 GUI 项目', url: 'https://github.com/MaaXYZ/MFAAvalonia', support: ['stable-windows-x64'], download: false },
]

/** Answers `latest` only when os and arch are asked exactly as uploaded (Mirror酱 matches them exactly). */
const UPLOADED: Record<string, { os: boolean; arch: boolean; version: string }> = {
  BGI: { os: false, arch: false, version: '0.66.0' },
  okgi: { os: false, arch: false, version: '1.2.0' },
  okww: { os: false, arch: false, version: 'v3.7.11' },
  'ZZZ-OneDragon': { os: false, arch: true, version: 'v2.5.6' },
  MaaNTE: { os: true, arch: true, version: 'v1.6.0' },
  Hidden: { os: false, arch: true, version: 'v9.0.0' },
}

async function fakeMirrorSite() {
  const state = { listUp: true, listAsked: 0 }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const reply = (status: number, body: object) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === '/api/misc/project') {
      state.listAsked++
      return state.listUp ? reply(200, { ec: 200, data: PROJECTS }) : reply(502, { ec: 502 })
    }
    const rid = /^\/api\/resources\/([^/]+)\/latest$/.exec(url.pathname)?.[1]
    const up = rid === undefined ? undefined : UPLOADED[decodeURIComponent(rid)]
    if (up === undefined || url.searchParams.has('os') !== up.os || url.searchParams.has('arch') !== up.arch) return reply(200, { code: 8001, msg: 'resource not found' })
    return reply(200, { code: 0, msg: 'ok', data: { version_name: up.version, channel: 'stable' } })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

function library(root: string, mirror: string, now: () => number) {
  mkdirSync(join(root, 'packs'), { recursive: true })
  return new ScriptLibrary({
    toolsDir: join(root, 'tools'), dataDir: join(root, 'data'), packDirs: [join(root, 'packs')],
    defaults: { apiBase: 'http://127.0.0.1:1' },
    credential: async () => undefined, credentialConfigured: async () => false,
    envHost: noHost, mirrorchyanBase: mirror, now,
    onChanged() {}, onJob() {}, log: { info() {}, warn() {} },
  })
}

test('what to ask Mirror酱 for a Windows x64 build, from the builds it lists', () => {
  assert.deepEqual(windowsResource('MAA', ['stable-windows-x64', 'stable-macos-arm64', 'MAA-Meow/stable-android-any']), { rid: 'MAA', platform: true, os: true, arch: true })
  assert.deepEqual(windowsResource('BGI', ['stable-any-any', 'alpha-windows-x64']), { rid: 'BGI', platform: false, os: false, arch: false }, 'the stable build, not the alpha one')
  assert.deepEqual(windowsResource('ZZZ', ['stable-any-x64', 'stable-any-arm64']), { rid: 'ZZZ', platform: false, os: false, arch: true })
  assert.deepEqual(windowsResource('Pets', ['stable-windows-any']), { rid: 'Pets', platform: false, os: true, arch: false })
  assert.deepEqual(windowsResource('NTE', ['stable-win-x64']), { rid: 'NTE', platform: true, os: true, arch: true })
  assert.equal(windowsResource('Paint', ['stable-android-any']), undefined)
  assert.equal(windowsResource('Sub', ['Sub_exec/stable-windows-x64']), undefined, 'another resource of the project')
})

test('Mirror酱 search by game name with no CDK; exact os/arch; a script found on Mirror酱 by its repository or name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-mirror-search-'))
  const site = await fakeMirrorSite()
  let clock = 1_000_000
  const lib = library(root, site.url, () => clock)
  await lib.start()
  try {
    const genshin = await lib.searchMirror('原神')
    assert.equal(genshin.from, 'mirrorchyan')
    assert.deepEqual(genshin.items.map(i => i.rid), ['BGI', 'okgi'], 'BetterGI (known) first, then ok-gi by its description')
    assert.equal(genshin.items[1]!.repo, 'ok-oldking/ok-genshin-impact', 'a GitHub home page is its repository')
    assert.deepEqual((await lib.searchMirror('鸣潮 战斗')).items.map(i => i.rid), ['okww'], 'every word must match')
    assert.deepEqual((await lib.searchMirror('bettergi')).items.map(i => i.rid), ['BGI'])
    const all = (await lib.searchMirror('')).items.map(i => i.rid)
    assert.ok(!all.includes('ReveriePaint') && !all.includes('MFAAvalonia'), 'no Windows build / not a downloadable game tool')
    assert.equal(site.state.listAsked, 1, 'the list is read once and kept')

    // Asked exactly as uploaded: arch only for 绝区零 一条龙, both for MaaNTE.
    const zzz = await lib.lookupMirror('zzz-onedragon')
    assert.deepEqual({ rid: zzz.rid, version: zzz.version, os: zzz.os, arch: zzz.arch }, { rid: 'ZZZ-OneDragon', version: '2.5.6', os: false, arch: true })
    assert.equal((await lib.lookupMirror('MaaNTE')).repo, '1bananachicken/MaaNTE')
    await assert.rejects(lib.lookupMirror('ReveriePaint'), /没有 Windows 版/)
    await assert.rejects(lib.lookupMirror('MFAAvalonia'), /没有 Windows 版|不提供/)
    // Not on the list: every way of asking is tried.
    assert.deepEqual(await lib.lookupMirror('Hidden'), { rid: 'Hidden', version: '9.0.0', platform: false, os: false, arch: true })
    await assert.rejects(lib.lookupMirror('Nothing'), /没有这个资源/)
    assert.equal((await mirrorLatest({ rid: 'ZZZ-OneDragon', platform: false, arch: true }, { base: site.url })).version, 'v2.5.6')

    // Is it on Mirror酱? A folder without any channel: by its name.
    const dir = join(root, 'ok-ww')
    mkdirSync(dir)
    writeFileSync(join(dir, 'ok-ww.exe'), 'MZ')
    const imported = await lib.import({ path: dir, name: '鸣潮 ok-ww' })
    const byName = await lib.matchMirror(imported.id)
    assert.deepEqual(byName.items.map(i => [i.rid, i.by]), [['okww', 'name']])
    // With a GitHub channel: by the repository.
    await lib.setUpdateSource(imported.id, { repo: 'ok-oldking/ok-genshin-impact' })
    assert.deepEqual((await lib.matchMirror(imported.id)).items.map(i => [i.rid, i.by]), [['okgi', 'repo']])
  } finally {
    lib.dispose()
    await site.close()
  }
})

test('the project list: kept a day on disk, an old copy when Mirror酱 is down, the known ones without any copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-mirror-cache-'))
  const site = await fakeMirrorSite()
  let clock = 1_000_000
  try {
    const first = library(root, site.url, () => clock)
    await first.start()
    await first.searchMirror('')
    first.dispose()
    assert.ok(existsSync(join(root, 'data', 'mirrorchyan-projects.json')))

    // A restart within the day: from disk, Mirror酱 not asked.
    const second = library(root, site.url, () => clock + 60_000)
    await second.start()
    assert.equal((await second.searchMirror('原神')).items.length, 2)
    assert.equal(site.state.listAsked, 1)

    // A day later and Mirror酱's list down: the old copy still answers.
    site.state.listUp = false
    clock += 25 * 60 * 60_000
    const third = library(root, site.url, () => clock)
    await third.start()
    const stale = await third.searchMirror('鸣潮')
    assert.deepEqual(stale.items.map(i => i.rid), ['okww'])
    assert.equal(stale.fetchedAt, 1_000_000)
    assert.equal(site.state.listAsked, 2)

    // No copy at all: the packs and known projects; a resource id can still be looked up.
    const fresh = library(mkdtempSync(join(tmpdir(), 'adg-mirror-nocache-')), site.url, () => clock)
    await fresh.start()
    const builtin = await fresh.searchMirror('原神')
    assert.equal(builtin.from, 'builtin')
    assert.deepEqual(builtin.items.map(i => i.rid), ['BGI'])
    assert.ok((await fresh.searchMirror('绝区零')).items.some(i => i.rid === 'ZZZ-OneDragon'))
    assert.equal((await fresh.lookupMirror('ZZZ-OneDragon')).version, '2.5.6', 'the known project says arch only')
    assert.equal((await fresh.lookupMirror('Hidden')).version, '9.0.0')
    third.dispose()
    second.dispose()
    fresh.dispose()
  } finally {
    await site.close()
  }
})
