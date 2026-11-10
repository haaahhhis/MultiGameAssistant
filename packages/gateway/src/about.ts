/**
 * 「设置 → 关于」 for the dsh plugin package (dsh-multigameassistant): which
 * version it is, and whether a newer one is out. The desktop app has its own
 * (apps/desktop/updates.mjs), which also installs; a plugin is updated in dsh,
 * by adding it again, so this only finds out and says how.
 *
 * The version is the one in the package's manifest: scripts/package-plugin.mjs
 * bundles this code into the package's lib/, beside it, and writes the release's
 * version there (the release workflow checks it is the tag's). A checkout's
 * gateway finds its own @adg/gateway manifest instead, and is not the plugin.
 */
import { readFileSync } from 'node:fs'
import { ErrorCode, RpcError, type RequestResult } from '@adg/protocol'
import type { CapabilityRegistration, MethodContext } from './registry.ts'

export const PLUGIN_PACKAGE = 'dsh-multigameassistant'
const RELEASES_URL = 'https://api.github.com/repos/haaahhhis/MultiGameAssistant/releases?per_page=30'
const NPM_URL = `https://registry.npmjs.org/${PLUGIN_PACKAGE}`
const TIMEOUT_MS = 15_000
/** The package the release workflow attaches for the plugin (no version in its name). */
const PLUGIN_ASSET = `${PLUGIN_PACKAGE}.tgz`

/** The plugin package's version, when this code runs from it; undefined anywhere else. */
export function pluginVersion(manifest: URL = new URL('../package.json', import.meta.url)): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown }
    if (pkg.name !== PLUGIN_PACKAGE || typeof pkg.version !== 'string') return undefined
    // packages/dsh-plugin's own copy, before a release writes the version in.
    return pkg.version === '0.0.0-source' ? undefined : pkg.version
  } catch {
    return undefined
  }
}

/**
 * -1, 0 or 1: release order, as apps/desktop/updates.mjs compares them (that one
 * is the desktop app's, outside any package): 1.2.0-rc.1 < 1.2.0 < 1.10.0.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = '', pre] = v.replace(/^v/, '').split('+')[0]!.split(/-(.*)/s)
    return { main: main.split('.').map(n => Number.parseInt(n, 10) || 0), pre: pre === undefined || pre === '' ? [] : pre.split('.') }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.main.length, y.main.length, 3); i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q))
    if (pn !== qn) return pn ? -1 : 1
    if (!pn && p !== q) return p < q ? -1 : 1
  }
  return 0
}

type Release = { tag_name?: unknown; draft?: unknown; prerelease?: unknown; html_url?: unknown; assets?: unknown }

/** The newest release newer than `current` that carries the plugin package; a pre-release only for a pre-release. */
export function newestRelease(releases: readonly Release[], current: string): { version: string; prerelease: boolean; notesUrl: string } | undefined {
  const pre = current.includes('-')
  return releases
    .filter(r => r.draft !== true && (pre || r.prerelease !== true) && typeof r.tag_name === 'string'
      && Array.isArray(r.assets) && r.assets.some(a => (a as { name?: unknown }).name === PLUGIN_ASSET))
    .map(r => ({ version: String(r.tag_name).replace(/^v/, ''), prerelease: r.prerelease === true, notesUrl: typeof r.html_url === 'string' ? r.html_url : '' }))
    .filter(r => compareVersions(r.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0]
}

export interface AboutDeps {
  /** This package's version; undefined when not the plugin (tests pass one). */
  readonly version?: () => string | undefined
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

export function aboutCapability(deps: AboutDeps = {}): CapabilityRegistration {
  const version = deps.version ?? (() => pluginVersion())
  const get = async (url: string, call: MethodContext): Promise<unknown> => {
    const response = await (deps.fetch ?? fetch)(url, {
      // GitHub's API refuses a request without a User-Agent.
      headers: { Accept: 'application/json', 'User-Agent': PLUGIN_PACKAGE },
      signal: AbortSignal.any([call.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
    if (!response.ok) throw new Error(`${new URL(url).host} 返回 ${response.status}`)
    return response.json()
  }

  const checkUpdate = async (call: MethodContext): Promise<RequestResult<'about/checkUpdate'>> => {
    const current = version()
    if (current === undefined) throw new RpcError(ErrorCode.InvalidRequest, '只有 dsh 插件版在这里检查更新')
    let releases: unknown
    try {
      releases = await get(RELEASES_URL, call)
    } catch (error) {
      throw new RpcError(ErrorCode.HostError, `连不上 GitHub，没能检查更新（${error instanceof Error ? error.message : String(error)}）`)
    }
    const found = Array.isArray(releases) ? newestRelease(releases as Release[], current) : undefined
    const checkedAt = (deps.now ?? Date.now)()
    if (found === undefined) return { current, checkedAt }
    // A release is on GitHub at once, and on npm only once approved there: say which way gets it.
    let onNpm: boolean | undefined
    try {
      const tags = ((await get(NPM_URL, call)) as { 'dist-tags'?: Record<string, unknown> })['dist-tags'] ?? {}
      const served = tags[found.prerelease ? 'next' : 'latest']
      onNpm = typeof served === 'string' && compareVersions(served, found.version) >= 0
    } catch {
      onNpm = undefined
    }
    return { current, latest: { ...found, ...(onNpm === undefined ? {} : { onNpm }) }, checkedAt }
  }

  return {
    id: 'about',
    version: 1,
    methods: {
      'about/info': () => {
        const v = version()
        return v === undefined ? { edition: 'other' } : { edition: 'plugin', version: v }
      },
      'about/checkUpdate': (_params, call) => checkUpdate(call),
    },
  }
}
