/**
 * GitHub REST client for the installer: releases, the latest release, and
 * repository search. Only public data is read; a token is optional and only
 * raises the rate limit.
 */
import type { ReleaseInfo } from '@adg/protocol'

export interface GitHubOptions {
  /** e.g. `https://api.github.com`. */
  readonly apiBase: string
  /** Read per request, so a token saved later applies without a restart. */
  readonly token?: () => Promise<string | undefined>
  readonly fetch?: typeof globalThis.fetch
  readonly userAgent?: string
  readonly timeoutMs?: number
}

/** A failed GitHub request, with the rate-limit facts when that was the cause. */
export class GitHubError extends Error {
  readonly status: number
  /** Epoch ms when the rate limit resets, if the response said. */
  readonly rateLimitReset: number | undefined

  constructor(message: string, status: number, rateLimitReset?: number) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.rateLimitReset = rateLimitReset
  }
}

interface ApiAsset { name: string; size: number; browser_download_url: string; digest?: string | null }
interface ApiRelease {
  tag_name: string; name: string | null; prerelease: boolean; draft: boolean
  published_at: string | null; html_url?: string; assets: ApiAsset[]; body?: string | null
}

export class GitHubClient {
  readonly #options: GitHubOptions
  readonly #fetch: typeof globalThis.fetch

  constructor(options: GitHubOptions) {
    this.#options = options
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  /** Published releases, newest first (drafts are never listed). */
  async releases(repo: string, limit = 10, signal?: AbortSignal): Promise<ReleaseInfo[]> {
    const list = await this.#get<ApiRelease[]>(`/repos/${repo}/releases?per_page=${Math.min(100, Math.max(1, limit))}`, signal)
    return list.filter(r => !r.draft).slice(0, limit).map(toRelease)
  }

  async release(repo: string, tag: string, signal?: AbortSignal): Promise<ReleaseInfo> {
    return toRelease(await this.#get<ApiRelease>(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, signal))
  }

  /**
   * The release to install when none is named: the latest stable one, else
   * (when allowed) the newest pre-release.
   * @throws GitHubError (404) when the repository has no usable release.
   */
  async latest(repo: string, options: { includePrereleases?: boolean; signal?: AbortSignal } = {}): Promise<ReleaseInfo> {
    try {
      return toRelease(await this.#get<ApiRelease>(`/repos/${repo}/releases/latest`, options.signal))
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error
    }
    if (options.includePrereleases === true) {
      const newest = (await this.releases(repo, 10, options.signal))[0]
      if (newest !== undefined) return newest
    }
    throw new GitHubError(`${repo} 没有${options.includePrereleases === true ? '' : '正式'}发布版本`, 404)
  }

  async search(query: string, limit = 10, signal?: AbortSignal): Promise<{ repo: string; description?: string; stars: number }[]> {
    const result = await this.#get<{ items: { full_name: string; description: string | null; stargazers_count: number }[] }>(
      `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${limit}`, signal,
    )
    return result.items.map(item => ({
      repo: item.full_name,
      stars: item.stargazers_count,
      ...(item.description === null ? {} : { description: item.description }),
    }))
  }

  async #get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const token = await this.#options.token?.()
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 20_000)
    let response: Response
    try {
      response = await this.#fetch(`${this.#options.apiBase.replace(/\/+$/, '')}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': this.#options.userAgent ?? 'MultiGameAssistant',
          ...(token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` }),
        },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw new GitHubError(`无法连接 GitHub（${this.#options.apiBase}）：${error instanceof Error ? error.message : String(error)}`, 0)
    }
    if (response.ok) return await response.json() as T
    const body = await response.json().catch(() => ({})) as { message?: string }
    if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
      const when = Number.isFinite(reset) && reset > 0 ? new Date(reset).toLocaleTimeString() : '稍后'
      throw new GitHubError(`GitHub 请求次数已达上限，${when} 恢复；在「设置 → 脚本安装」填写 GitHub Token 可提高上限`, response.status, Number.isFinite(reset) ? reset : undefined)
    }
    if (response.status === 404) throw new GitHubError(`GitHub 上找不到 ${path.split('?')[0]}`, 404)
    throw new GitHubError(`GitHub 返回 ${response.status}：${body.message ?? response.statusText}`, response.status)
  }
}

function toRelease(r: ApiRelease): ReleaseInfo {
  return {
    tag: r.tag_name,
    name: r.name ?? r.tag_name,
    prerelease: r.prerelease,
    ...(r.published_at === null ? {} : { publishedAt: r.published_at }),
    ...(r.html_url === undefined ? {} : { url: r.html_url }),
    ...(typeof r.body === 'string' && r.body.trim() !== '' ? { notes: r.body } : {}),
    assets: r.assets.map(a => ({
      name: a.name,
      size: a.size,
      downloadUrl: a.browser_download_url,
      ...(typeof a.digest === 'string' ? { digest: a.digest } : {}),
    })),
  }
}
