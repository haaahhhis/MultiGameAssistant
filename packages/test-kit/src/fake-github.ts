/**
 * Fake GitHub releases API on loopback.
 *
 * Serves the subset the installer uses: `GET /repos/{owner}/{repo}/releases`,
 * `.../releases/latest`, `.../releases/tags/{tag}`, and asset downloads. Faults
 * (rate limiting, server errors, dropped connections) can be switched on per
 * test, so failure paths are exercised without the network.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeAsset {
  readonly name: string
  readonly content: Uint8Array | string
  readonly contentType?: string
  /** Published digest; default: the real SHA-256; `null` publishes none. */
  readonly digest?: string | null
}

function bytesOf(asset: FakeAsset): Buffer {
  return typeof asset.content === 'string' ? Buffer.from(asset.content) : Buffer.from(asset.content)
}

export interface FakeRelease {
  readonly tag: string
  readonly name?: string
  readonly prerelease?: boolean
  readonly draft?: boolean
  readonly body?: string
  /** ISO time; releases are listed newest first by this. */
  readonly publishedAt?: string
  readonly assets: readonly FakeAsset[]
}

export interface FakeGitHubOptions {
  /** `owner/repo` → releases. */
  readonly repos: Readonly<Record<string, readonly FakeRelease[]>>
}

export type FakeFault =
  | { readonly kind: 'rate-limit'; readonly resetAt?: number }
  | { readonly kind: 'status'; readonly status: number }
  /** Close the socket mid-response, like a dropped connection. */
  | { readonly kind: 'drop' }

export interface FakeGitHub {
  /** e.g. `http://127.0.0.1:54321`; use as the API base URL. */
  readonly url: string
  /** Every request path seen, in order. */
  readonly requests: readonly string[]
  /** Apply `fault` to the next `count` requests (default: until cleared). */
  fault(fault: FakeFault | null, count?: number): void
  close(): Promise<void>
}

/** Start the server on a free loopback port. */
export async function startFakeGitHub(options: FakeGitHubOptions): Promise<FakeGitHub> {
  const requests: string[] = []
  let fault: FakeFault | null = null
  let faultsLeft = Infinity
  let base = ''

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    requests.push(path)
    if (fault !== null && faultsLeft > 0) {
      faultsLeft -= 1
      const current = fault
      if (faultsLeft === 0) fault = null
      applyFault(current, res)
      return
    }
    route(path, req, res)
  })

  function route(path: string, req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') return json(res, 405, { message: 'Method Not Allowed' })
    const download = /^\/download\/([^/]+\/[^/]+)\/([^/]+)\/([^/]+)$/.exec(path)
    if (download !== null) {
      const [, repo, tag, name] = download.map(decodeURIComponent) as [string, string, string, string]
      const asset = options.repos[repo]?.find(r => r.tag === tag)?.assets.find(a => a.name === name)
      if (asset === undefined) return json(res, 404, { message: 'Not Found' })
      const body = bytesOf(asset)
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
      if (range !== null) {
        const start = Number(range[1])
        if (start >= body.length) {
          res.writeHead(416, { 'content-range': `bytes */${body.length}` })
          res.end()
          return
        }
        res.writeHead(206, { 'content-type': asset.contentType ?? 'application/octet-stream', 'content-length': body.length - start, 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` })
        res.end(body.subarray(start))
        return
      }
      res.writeHead(200, { 'content-type': asset.contentType ?? 'application/octet-stream', 'content-length': body.length })
      res.end(body)
      return
    }
    if (path === '/search/repositories') {
      const q = (new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? '').toLowerCase()
      const items = Object.keys(options.repos).filter(repo => repo.toLowerCase().includes(q))
        .map(repo => ({ full_name: repo, description: `fake ${repo}`, stargazers_count: 1 }))
      return json(res, 200, { total_count: items.length, items })
    }
    const api = /^\/repos\/([^/]+\/[^/]+)\/releases(?:\/(latest|tags\/(.+)))?$/.exec(path)
    if (api === null) return json(res, 404, { message: 'Not Found' })
    const repo = decodeURIComponent(api[1]!)
    const releases = options.repos[repo]
    if (releases === undefined) return json(res, 404, { message: 'Not Found' })
    const published = [...releases].filter(r => r.draft !== true)
      .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    if (api[2] === undefined) return json(res, 200, published.map(r => toApi(repo, r)))
    const found = api[2] === 'latest'
      ? published.find(r => r.prerelease !== true)
      : published.find(r => r.tag === decodeURIComponent(api[3]!))
    if (found === undefined) return json(res, 404, { message: 'Not Found' })
    json(res, 200, toApi(repo, found))
  }

  function toApi(repo: string, release: FakeRelease) {
    return {
      tag_name: release.tag,
      name: release.name ?? release.tag,
      prerelease: release.prerelease ?? false,
      draft: release.draft ?? false,
      body: release.body ?? '',
      published_at: release.publishedAt ?? null,
      html_url: `${base}/${repo}/releases/tag/${encodeURIComponent(release.tag)}`,
      assets: release.assets.map((asset, index) => ({
        id: index + 1,
        name: asset.name,
        size: bytesOf(asset).length,
        digest: asset.digest === null ? null : asset.digest ?? `sha256:${createHash('sha256').update(bytesOf(asset)).digest('hex')}`,
        content_type: asset.contentType ?? 'application/octet-stream',
        browser_download_url: `${base}/download/${repo}/${encodeURIComponent(release.tag)}/${encodeURIComponent(asset.name)}`,
      })),
    }
  }

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url: base,
    requests,
    fault(next, count = Infinity) {
      fault = next
      faultsLeft = next === null ? 0 : count
    },
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

function applyFault(fault: FakeFault, res: ServerResponse): void {
  if (fault.kind === 'drop') {
    res.socket?.destroy()
    return
  }
  if (fault.kind === 'rate-limit') {
    res.writeHead(403, {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor((fault.resetAt ?? Date.now() + 3_600_000) / 1000)),
    })
    res.end(JSON.stringify({ message: 'API rate limit exceeded' }))
    return
  }
  json(res, fault.status, { message: `fault ${fault.status}` })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
