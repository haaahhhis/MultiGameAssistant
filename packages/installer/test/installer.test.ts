import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeZip, startFakeGitHub } from '@adg/test-kit'
import { download } from '../src/download.ts'
import { checkEnvironment, satisfies, type EnvHost } from '../src/env.ts'
import { extract } from '../src/extract.ts'
import { applyFix } from '../src/fix.ts'
import { GitHubClient, GitHubError } from '../src/github.ts'
import { matchesDetect, probeProject } from '../src/probe.ts'

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `adg-${prefix}-`))
const REPO = 'Owner/Tool'

async function withGitHub<T>(fn: (github: Awaited<ReturnType<typeof startFakeGitHub>>, zip: Buffer) => Promise<T>): Promise<T> {
  const zip = makeZip({ 'Tool/': '', 'Tool/tool.exe': 'MZ fake', 'Tool/config/gui.json': '{"a":1}' })
  const github = await startFakeGitHub({
    repos: {
      [REPO]: [
        { tag: 'v1.0.0', publishedAt: '2026-09-01T00:00:00Z', assets: [{ name: 'Tool-v1.0.0-win-x64.zip', content: zip }] },
        { tag: 'v1.1.0-beta.1', prerelease: true, publishedAt: '2026-10-01T00:00:00Z', assets: [] },
      ],
      'Owner/OnlyBeta': [{ tag: 'v0.1.0', prerelease: true, assets: [] }],
    },
  })
  try {
    return await fn(github, zip)
  } finally {
    await github.close()
  }
}

test('GitHub client lists releases, resolves latest, and explains failures', () => withGitHub(async github => {
  const client = new GitHubClient({ apiBase: github.url })
  assert.deepEqual((await client.releases(REPO)).map(r => r.tag), ['v1.1.0-beta.1', 'v1.0.0'])
  const latest = await client.latest(REPO)
  assert.equal(latest.tag, 'v1.0.0')
  assert.match(latest.assets[0]!.digest ?? '', /^sha256:[0-9a-f]{64}$/)

  await assert.rejects(client.latest('Owner/OnlyBeta'), /没有正式发布版本/)
  assert.equal((await client.latest('Owner/OnlyBeta', { includePrereleases: true })).tag, 'v0.1.0')
  assert.deepEqual((await client.search('tool')).map(r => r.repo), [REPO])

  github.fault({ kind: 'rate-limit' }, 1)
  await assert.rejects(client.latest(REPO), (error: unknown) => error instanceof GitHubError && /次数已达上限/.test(error.message) && error.rateLimitReset !== undefined)
  await assert.rejects(new GitHubClient({ apiBase: 'http://127.0.0.1:1' }).latest(REPO), /无法连接 GitHub/)
}))

test('downloads verify the digest, resume a partial file, and fall back from a dead mirror', () => withGitHub(async (github, zip) => {
  const dir = tmp('dl')
  const asset = (await new GitHubClient({ apiBase: github.url }).latest(REPO)).assets[0]!
  const progress: number[] = []
  const first = await download({ url: asset.downloadUrl, dest: join(dir, 'a.zip'), expectedSize: asset.size, digest: asset.digest!, onProgress: r => progress.push(r) })
  assert.equal(first.bytes, zip.length)
  assert.deepEqual(readFileSync(join(dir, 'a.zip')), zip)
  assert.equal(progress.at(-1), zip.length)

  writeFileSync(join(dir, 'b.zip.part'), zip.subarray(0, 10))
  const resumed = await download({ url: asset.downloadUrl, dest: join(dir, 'b.zip'), expectedSize: asset.size, digest: asset.digest! })
  assert.ok(resumed.resumed)
  assert.deepEqual(readFileSync(join(dir, 'b.zip')), zip)

  await assert.rejects(download({ url: asset.downloadUrl, dest: join(dir, 'c.zip'), digest: `sha256:${'0'.repeat(64)}` }), /校验失败/)
  assert.ok(!existsSync(join(dir, 'c.zip')) && !existsSync(join(dir, 'c.zip.part')), 'a corrupt file is not kept')

  const viaFallback = await download({ url: asset.downloadUrl, dest: join(dir, 'd.zip'), mirror: 'http://127.0.0.1:1/' })
  assert.equal(viaFallback.via, asset.downloadUrl)
  await assert.rejects(download({ url: asset.downloadUrl, dest: join(dir, 'e.zip'), mirror: 'http://127.0.0.1:1/', mirrorFallback: false }), /连接 127\.0\.0\.1:1 失败/)
}))

test('extraction lifts a single top folder and refuses paths that escape', async () => {
  const dir = tmp('x')
  writeFileSync(join(dir, 'tool.zip'), makeZip({ 'Tool/': '', 'Tool/tool.exe': 'MZ', 'Tool/sub/a.txt': 'a' }))
  const result = await extract(join(dir, 'tool.zip'), join(dir, 'out'))
  assert.equal(result.liftedRoot, 'Tool')
  assert.equal(readFileSync(join(dir, 'out', 'sub', 'a.txt'), 'utf8'), 'a')
  await assert.rejects(extract(join(dir, 'tool.zip'), join(dir, 'out')), /已存在/)

  writeFileSync(join(dir, 'flat.zip'), makeZip({ 'a.exe': 'MZ', 'b.dll': 'x' }))
  assert.equal((await extract(join(dir, 'flat.zip'), join(dir, 'flat'))).liftedRoot, undefined)
  assert.ok(existsSync(join(dir, 'flat', 'a.exe')))

  writeFileSync(join(dir, 'evil.zip'), makeZip({ '../escape.txt': 'boom' }))
  await assert.rejects(extract(join(dir, 'evil.zip'), join(dir, 'evil')))
  assert.ok(!existsSync(join(dir, 'escape.txt')) && !existsSync(join(dir, 'evil')))

  writeFileSync(join(dir, 'setup.exe'), 'MZ')
  await extract(join(dir, 'setup.exe'), join(dir, 'single'))
  assert.ok(existsSync(join(dir, 'single', 'setup.exe')))
})

function fakeHost(spec: { dirs?: Record<string, string[]>; files?: string[]; exec?: Record<string, { code: number; stdout: string }> }): EnvHost {
  return {
    exec: async (file, args) => spec.exec?.[[file, ...args].join(' ')] === undefined ? undefined : { ...spec.exec[[file, ...args].join(' ')]!, stderr: '' },
    exists: async path => spec.files?.includes(path) ?? false,
    listDir: async path => spec.dirs?.[path] ?? [],
    env: name => ({ ProgramFiles: 'C:\\Program Files' })[name],
  }
}

test('environment checks report found versions and the fix for what is missing', async () => {
  const desktopDir = join('C:\\Program Files', 'dotnet', 'shared', 'Microsoft.WindowsDesktop.App')
  const host = fakeHost({
    dirs: { [desktopDir]: ['6.0.36', '8.0.11'] },
    exec: {
      'reg query HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64 /v Version': { code: 0, stdout: '    Version    REG_SZ    v14.40.33810.00\r\n' },
      'node --version': { code: 0, stdout: 'v18.20.0\n' },
    },
  })
  const { report, plans } = await checkEnvironment([
    { kind: 'dotnet-desktop-runtime', version: '>=8' },
    { kind: 'vcredist' },
    { kind: 'adb', optional: true },
    { kind: 'node', version: '>=22' },
    { kind: 'python' },
    { kind: 'teleporter' },
  ], { host, sharedDir: 'D:\\tools\\_shared' }, 1)
  const byKind = Object.fromEntries(report.items.map(i => [i.kind, i]))
  assert.equal(byKind['dotnet-desktop-runtime']!.status, 'ok')
  assert.equal(byKind['dotnet-desktop-runtime']!.found, '8.0.11')
  assert.equal(byKind['vcredist']!.status, 'ok')
  assert.equal(byKind['vcredist']!.found, '14.40.33810.00')
  assert.equal(byKind['adb']!.status, 'missing')
  assert.equal(byKind['adb']!.fix?.kind, 'auto')
  assert.equal(byKind['node']!.status, 'outdated')
  assert.equal(byKind['python']!.status, 'missing')
  assert.equal(byKind['python']!.fix?.kind, 'manual')
  assert.equal(byKind['teleporter']!.status, 'unsupported')
  assert.equal(report.ok, false, 'node and python block; optional adb and unknown kinds do not')
  assert.ok(plans.has('adb') && !plans.has('vcredist'))

  const missing = await checkEnvironment([{ kind: 'dotnet-desktop-runtime', version: '>=8' }], { host: fakeHost({}), sharedDir: 'x' })
  const plan = missing.plans.get('dotnet-desktop-runtime')
  assert.equal(plan?.kind, 'run-installer')
  assert.match(plan?.kind === 'run-installer' ? plan.url : '', /aka\.ms\/dotnet\/8\.0\/windowsdesktop-runtime-win-x64\.exe$/)
  assert.equal(missing.report.items[0]!.fix?.needsAdmin, true)
})

test('version ranges', () => {
  assert.ok(satisfies('8.0.11', '>=8'))
  assert.ok(!satisfies('6.0.36', '>=8'))
  assert.ok(satisfies('3.12.1', '>=3.11 <3.13'))
  assert.ok(satisfies('8.0.11', '8'))
  assert.ok(!satisfies('80.0.1', '8'))
  assert.ok(satisfies('3.11.9', '^3.11') && !satisfies('4.0.0', '^3.11'))
  assert.ok(satisfies('1.0.0', undefined))
})

test('an auto fix downloads and unpacks into the shared tools directory', async () => {
  const shared = tmp('shared')
  await applyFix({ kind: 'download-extract', url: 'https://example.invalid/platform-tools-latest-windows.zip', into: join(shared, 'platform-tools'), description: '' }, {
    sharedDir: shared,
    download: async (_url, dest) => {
      mkdirSync(join(shared, 'downloads'), { recursive: true })
      writeFileSync(dest, makeZip({ 'platform-tools/': '', 'platform-tools/adb.exe': 'MZ' }))
    },
  })
  assert.ok(existsSync(join(shared, 'platform-tools', 'adb.exe')))

  let ran: string[] = []
  await applyFix({ kind: 'run-installer', url: 'https://example.invalid/vc_redist.x64.exe', fileName: 'vc_redist.x64.exe', args: ['/install', '/quiet'], okCodes: [0, 3010], description: '' }, {
    sharedDir: shared,
    download: async (_url, dest) => writeFileSync(dest, 'MZ'),
    runElevated: async (file, args) => { ran = [file, ...args]; return 3010 },
  })
  assert.deepEqual(ran, [join(shared, 'downloads', 'vc_redist.x64.exe'), '/install', '/quiet'])
  await assert.rejects(applyFix({ kind: 'run-installer', url: 'https://example.invalid/x.exe', fileName: 'x.exe', args: [], okCodes: [0], description: '' }, {
    sharedDir: shared, download: async (_url, dest) => writeFileSync(dest, 'MZ'), runElevated: async () => 1223,
  }), /取消管理员授权/)
  await assert.rejects(applyFix({ kind: 'manual', description: '请安装 Python' }, { sharedDir: shared, download: async () => {} }), /需要手动处理/)
})

test('a directory probe finds launchers, markers and the MaaFramework family', async () => {
  const dir = tmp('probe')
  writeFileSync(join(dir, 'interface.json'), '{}')
  writeFileSync(join(dir, 'MaaEnd.exe'), 'MZ')
  writeFileSync(join(dir, 'uninstall.exe'), 'MZ')
  mkdirSync(join(dir, 'resource'))
  const probe = await probeProject(dir)
  assert.deepEqual(probe.executables, ['MaaEnd.exe'])
  assert.deepEqual(probe.markers, ['interface.json', 'resource'])
  assert.equal(probe.family, 'maafw-pi')
  assert.ok(await matchesDetect(dir, ['interface.json', 'MaaEnd.exe']))
  assert.ok(!(await matchesDetect(dir, ['MAA.exe'])))
})
