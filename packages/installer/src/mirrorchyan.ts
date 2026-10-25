/**
 * Mirror酱 (https://mirrorchyan.com, docs: https://github.com/MirrorChyan/docs):
 * a paid download mirror many game scripts publish to. Asking for the latest
 * version needs no key; a download link comes only with the user's CDK, and
 * when the current version is given it is an incremental package (the changed
 * files and a `changes.json` saying what to delete). Without a CDK, or when
 * Mirror酱 has nothing, the caller falls back to GitHub.
 */
import { readFile, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface MirrorResource {
  /** The resource id Mirror酱 gave the project (`MAA`, `M9A`…). */
  readonly rid: string
  /** Uploaded per system and architecture: ask with `os` and `arch` (and without them otherwise, or Mirror酱 answers "not found"). */
  readonly platform: boolean
  /**
   * Ask with `os=windows` / `arch=x64` each on its own (overriding
   * `platform`): Mirror酱 matches them exactly, and some builds are uploaded
   * for any system but one architecture.
   */
  readonly os?: boolean | undefined
  readonly arch?: boolean | undefined
}

export interface MirrorLatest {
  /** As uploaded, e.g. `v6.20.1`. */
  readonly version: string
  /** Time-limited download link: only with a valid CDK and when there is something newer than `current_version`. */
  readonly url?: string
  readonly sha256?: string
  readonly size?: number
  readonly updateType?: 'full' | 'incremental'
  readonly releaseNote?: string
  /** When the CDK runs out (ms). */
  readonly cdkExpiresAt?: number
}

export class MirrorChyanError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'MirrorChyanError'
    this.code = code
  }

  /** The CDK is the problem (expired, wrong, used up, banned): worth telling the user, not worth failing the update over. */
  get aboutCdk(): boolean {
    return this.code >= 7001 && this.code <= 7005
  }
}

/** What each answer code means, in the user's words. */
const CODES: Readonly<Record<number, string>> = {
  1001: '请求参数不对',
  7001: 'CDK 已过期，续费后才能用 Mirror酱 下载',
  7002: 'CDK 不对，请在「设置 → 脚本安装」里检查',
  7003: 'CDK 今天的下载次数用完了，明天再试',
  7004: '这个 CDK 不能用于这个资源',
  7005: 'CDK 已被封禁，请联系 Mirror酱 售后',
  8001: 'Mirror酱 上没有这个资源（或没有适合本机的包）',
  8002: '系统参数不对',
  8003: '架构参数不对',
  8004: '更新通道参数不对',
  8009: '这是流程测试用的 CDK，不能下载',
}

export interface MirrorOptions {
  readonly cdk?: string | undefined
  /** As uploaded (with or without `v`): an incremental package is offered from it. */
  readonly currentVersion?: string | undefined
  readonly channel?: 'stable' | 'beta' | 'alpha'
  /** @default https://mirrorchyan.com */
  readonly base?: string
  readonly fetch?: typeof globalThis.fetch
  readonly signal?: AbortSignal
  /** @default 15000 */
  readonly timeoutMs?: number
}

/** Shows up in Mirror酱's statistics as where the request came from. */
export const MIRROR_USER_AGENT = 'MultiGameAssistant'

/** @throws MirrorChyanError for an answer other than success, Error when Mirror酱 cannot be reached. */
export async function mirrorLatest(resource: MirrorResource, options: MirrorOptions = {}): Promise<MirrorLatest> {
  const url = new URL(`/api/resources/${encodeURIComponent(resource.rid)}/latest`, options.base ?? 'https://mirrorchyan.com')
  if (options.currentVersion !== undefined) url.searchParams.set('current_version', options.currentVersion)
  if (options.cdk !== undefined && options.cdk !== '') url.searchParams.set('cdk', options.cdk)
  if (resource.os ?? resource.platform) url.searchParams.set('os', 'windows')
  if (resource.arch ?? resource.platform) url.searchParams.set('arch', 'x64')
  if (options.channel !== undefined) url.searchParams.set('channel', options.channel)
  url.searchParams.set('user_agent', MIRROR_USER_AGENT)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let body: { code?: unknown; msg?: unknown; data?: Record<string, unknown> }
  try {
    // The address holds the CDK: errors never repeat it.
    const response = await (options.fetch ?? globalThis.fetch)(url, { signal, headers: { accept: 'application/json' } })
    body = await response.json() as typeof body
  } catch (error) {
    if (options.signal?.aborted === true) throw error
    throw new Error(`连不上 Mirror酱：${timeout.aborted ? '超时' : error instanceof Error ? error.message : String(error)}`)
  }
  const code = typeof body.code === 'number' ? body.code : -1
  if (code !== 0) throw new MirrorChyanError(code, CODES[code] ?? (code > 0 && typeof body.msg === 'string' ? `Mirror酱：${body.msg}` : `Mirror酱 出错了（${code}）`))
  const data = body.data ?? {}
  const text = (key: string) => (typeof data[key] === 'string' && data[key] !== '' ? data[key] as string : undefined)
  const version = text('version_name')
  if (version === undefined) throw new MirrorChyanError(-1, 'Mirror酱 没有给出版本号')
  const updateType = text('update_type')
  const expires = typeof data['cdk_expired_time'] === 'number' ? data['cdk_expired_time'] * 1000 : undefined
  return {
    version,
    ...(text('url') === undefined ? {} : { url: text('url')! }),
    ...(text('sha256') === undefined ? {} : { sha256: text('sha256')!.toLowerCase() }),
    ...(typeof data['filesize'] === 'number' ? { size: data['filesize'] } : {}),
    ...(updateType === 'full' || updateType === 'incremental' ? { updateType } : {}),
    ...(text('release_note') === undefined ? {} : { releaseNote: text('release_note')! }),
    ...(expires === undefined ? {} : { cdkExpiresAt: expires }),
  }
}

/** `changes.json` of an incremental package (paths relative to the package root, `/`-separated; empty kinds are left out). */
export interface MirrorChanges {
  readonly added?: readonly string[]
  readonly modified?: readonly string[]
  readonly deleted?: readonly string[]
  readonly added_dir?: readonly string[]
  readonly deleted_dir?: readonly string[]
}

/**
 * What `changes.json` in `dir` says went away, as paths relative to `dir`
 * (`/`-separated); a path that would leave `dir` is refused. `prefix`: the
 * package's top folder that was lifted off (its paths start with it).
 * @returns undefined when there is no (readable) `changes.json`.
 */
export async function readMirrorChanges(dir: string, prefix?: string): Promise<string[] | undefined> {
  let changes: MirrorChanges
  try { changes = JSON.parse(await readFile(join(dir, 'changes.json'), 'utf8')) as MirrorChanges } catch { return undefined }
  const root = resolve(dir)
  const lifted = (path: string) => (prefix !== undefined && path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path)
  return [...(changes.deleted ?? []), ...(changes.deleted_dir ?? [])].map(lifted).map(path => {
    const refused = new Error(`changes.json 里的路径不在安装目录里：${path}`)
    if (isAbsolute(path) || path.split('/').includes('..')) throw refused
    const rel = relative(root, resolve(root, ...path.split('/')))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) throw refused
    return rel.split(sep).join('/')
  })
}

/**
 * After an incremental package was copied over a copy of the previous
 * version in `dir`: delete what `changes.json` says went away, then the file
 * itself (see {@link readMirrorChanges}).
 * @returns how many files and folders were removed.
 */
export async function applyMirrorChanges(dir: string, prefix?: string): Promise<number> {
  const gone = await readMirrorChanges(dir, prefix)
  if (gone === undefined) return 0
  let removed = 0
  for (const path of gone) {
    const target = join(dir, ...path.split('/'))
    if (await stat(target).then(() => true, () => false)) {
      await rm(target, { recursive: true, force: true })
      removed++
    }
  }
  await rm(join(dir, 'changes.json'), { force: true })
  return removed
}
