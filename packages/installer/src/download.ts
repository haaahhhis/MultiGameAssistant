/**
 * Resumable, verified download to a file.
 *
 * Bytes land in `<dest>.part`; an interrupted download resumes with a Range
 * request. The file is renamed to `dest` only after its size and, when the
 * release publishes one, its SHA-256 digest match. An optional mirror prefix
 * (ghproxy style) is tried first, falling back to the direct URL.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface DownloadOptions {
  readonly url: string
  readonly dest: string
  /** Prefix put before `url`, e.g. `https://ghfast.top/`; empty or undefined downloads directly. */
  readonly mirror?: string
  /** Retry the direct URL when the mirror fails. @default true */
  readonly mirrorFallback?: boolean
  readonly expectedSize?: number
  /** `sha256:<hex>`, as GitHub publishes for release assets. */
  readonly digest?: string
  readonly signal?: AbortSignal
  readonly onProgress?: (received: number, total: number | undefined) => void
  readonly fetch?: typeof globalThis.fetch
  readonly userAgent?: string
}

export interface DownloadResult {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  /** The URL that served the bytes. */
  readonly via: string
  readonly resumed: boolean
}

export class DownloadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DownloadError'
  }
}

export async function download(options: DownloadOptions): Promise<DownloadResult> {
  const mirror = options.mirror?.trim() ?? ''
  const urls = mirror === '' ? [options.url] : [mirrored(mirror, options.url), ...(options.mirrorFallback === false ? [] : [options.url])]
  let lastError: unknown
  for (const url of urls) {
    options.signal?.throwIfAborted()
    try {
      return await downloadFrom(url, options)
    } catch (error) {
      if (options.signal?.aborted === true || error instanceof IntegrityError) throw error
      lastError = error
    }
  }
  throw lastError instanceof DownloadError ? lastError : new DownloadError(`下载失败：${errorText(lastError)}`, { cause: lastError })
}

/** `https://ghfast.top/` + `https://github.com/...` → `https://ghfast.top/https://github.com/...`. */
export function mirrored(mirror: string, url: string): string {
  return `${mirror.endsWith('/') ? mirror : `${mirror}/`}${url}`
}

class IntegrityError extends DownloadError {}

async function downloadFrom(url: string, options: DownloadOptions): Promise<DownloadResult> {
  const part = `${options.dest}.part`
  await mkdir(dirname(options.dest), { recursive: true })
  const have = await stat(part).then(s => s.size, () => 0)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(url, {
    headers: { 'user-agent': options.userAgent ?? 'MultiGameAssistant', ...(have > 0 ? { range: `bytes=${have}-` } : {}) },
    redirect: 'follow',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }).catch(error => { throw new DownloadError(`连接 ${host(url)} 失败：${errorText(error)}`, { cause: error }) })

  const resumed = response.status === 206 && have > 0
  if (response.status === 416 && have > 0 && have === options.expectedSize) {
    await response.body?.cancel()
  } else if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new DownloadError(`${host(url)} 返回 ${response.status}`)
  } else {
    const length = Number(response.headers.get('content-length'))
    const total = options.expectedSize ?? (Number.isFinite(length) && length > 0 ? length + (resumed ? have : 0) : undefined)
    let received = resumed ? have : 0
    let lastReport = 0
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length
        const now = Date.now()
        if (now - lastReport > 200) {
          lastReport = now
          options.onProgress?.(received, total)
        }
        done(null, chunk)
      },
    })
    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        counter,
        createWriteStream(part, { flags: resumed ? 'a' : 'w' }),
        ...(options.signal === undefined ? [] : [{ signal: options.signal }]),
      )
    } catch (error) {
      if (options.signal?.aborted === true) throw options.signal.reason ?? error
      throw new DownloadError(`从 ${host(url)} 下载中断：${errorText(error)}`, { cause: error })
    }
    options.onProgress?.(received, total)
  }

  const bytes = (await stat(part)).size
  if (options.expectedSize !== undefined && bytes !== options.expectedSize) {
    await rm(part, { force: true })
    throw new DownloadError(`文件大小不符：应为 ${options.expectedSize} 字节，实际 ${bytes} 字节`)
  }
  const sha256 = await hashFile(part)
  const expected = parseDigest(options.digest)
  if (expected !== undefined && expected !== sha256) {
    await rm(part, { force: true })
    throw new IntegrityError(`校验失败：SHA-256 应为 ${expected}，实际 ${sha256}；文件已删除`)
  }
  await rm(options.dest, { force: true })
  await rename(part, options.dest)
  return { path: options.dest, bytes, sha256, via: url, resumed }
}

function parseDigest(digest: string | undefined): string | undefined {
  if (digest === undefined) return undefined
  const match = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim())
  return match?.[1]?.toLowerCase()
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function host(url: string): string {
  try { return new URL(url).host } catch { return url }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.cause instanceof Error ? `${error.message}（${error.cause.message}）` : error.message
  return String(error)
}
