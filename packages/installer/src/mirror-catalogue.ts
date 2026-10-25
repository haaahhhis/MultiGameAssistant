/**
 * Mirror酱's list of projects, as its website shows them
 * (`GET /api/misc/project`; not part of the documented API, so callers keep
 * a built-in list to fall back on). Each entry says which builds were
 * uploaded (`support`: `channel-os-arch`, e.g. `stable-windows-x64`,
 * `stable-any-any`); that decides what a request must say: Mirror酱 matches
 * os and arch exactly (`stable-any-x64` asked with an os is "not found",
 * and asked without the arch answers an outdated build).
 */
import type { MirrorResource } from './mirrorchyan.ts'
import { MIRROR_USER_AGENT } from './mirrorchyan.ts'

export interface MirrorProject {
  readonly rid: string
  readonly name: string
  readonly description: string
  /** Mirror酱's category: `GameTools`, `Dependencies`… */
  readonly type: string
  /** Its home page. */
  readonly url?: string
  /** `owner/repo` when the home page is on GitHub. */
  readonly repo?: string
  /** Mirror酱 hands out downloads for it. */
  readonly download: boolean
  /** How to ask for its stable Windows x64 build; undefined when there is none. */
  readonly windows?: MirrorResource
}

/** How to ask for the stable Windows x64 build, from `support`; undefined when none was uploaded. */
export function windowsResource(rid: string, support: readonly string[]): MirrorResource | undefined {
  let best: { os: boolean; arch: boolean; score: number } | undefined
  for (const entry of support) {
    // `name/channel-os-arch` is a different resource of the project (an Android build, an installer…).
    if (entry.includes('/')) continue
    const [channel, os, arch] = entry.toLowerCase().split('-')
    if (channel !== 'stable' || os === undefined || arch === undefined) continue
    if (!['windows', 'win', 'any'].includes(os) || !['x64', 'amd64', 'any'].includes(arch)) continue
    const candidate = { os: os !== 'any', arch: arch !== 'any', score: Number(os !== 'any') + Number(arch !== 'any') }
    if (best === undefined || candidate.score > best.score) best = candidate
  }
  return best === undefined ? undefined : { rid, platform: best.os && best.arch, os: best.os, arch: best.arch }
}

export async function mirrorCatalogue(options: { base?: string; fetch?: typeof globalThis.fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<MirrorProject[]> {
  const url = new URL('/api/misc/project', options.base ?? 'https://mirrorchyan.com')
  url.searchParams.set('user_agent', MIRROR_USER_AGENT)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let body: { data?: unknown }
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, { signal, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    body = await response.json() as typeof body
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    throw new Error(`读不到 Mirror酱 的项目列表：${timeout.aborted ? '超时' : error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(body.data)) throw new Error('Mirror酱 的项目列表格式变了')
  const projects: MirrorProject[] = []
  for (const item of body.data as Record<string, unknown>[]) {
    const text = (key: string) => (typeof item[key] === 'string' ? (item[key] as string).trim() : '')
    const rid = text('resource')
    if (rid === '' || !/^[A-Za-z0-9_.-]{1,100}$/.test(rid)) continue
    const support = Array.isArray(item['support']) ? (item['support'] as unknown[]).filter((s): s is string => typeof s === 'string') : []
    const home = text('url')
    const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(home)?.[1]
    const windows = windowsResource(rid, support)
    projects.push({
      rid,
      name: text('name') || rid,
      description: text('desc'),
      type: text('type_id'),
      download: item['download'] === true,
      ...(home === '' ? {} : { url: home }),
      ...(repo === undefined ? {} : { repo }),
      ...(windows === undefined ? {} : { windows }),
    })
  }
  return projects
}
