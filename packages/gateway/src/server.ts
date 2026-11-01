/**
 * HTTP listener: `/rpc` WebSocket upgrade for the protocol, `/health`, and
 * optional static hosting of a built UI. Every upgrade must present the
 * gateway token; Host and Origin are checked against loopback (plus any
 * configured authorities) to block DNS rebinding and cross-site sockets.
 *
 * The same sockets and UI are also served under dsh's own web server at
 * `MOUNT` (index.ts), where dsh's login stands in for the token.
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'

/** Where the UI and its socket are under dsh's web server. */
export const MOUNT = '/adg'

export interface ServerOptions {
  readonly host: string
  readonly port: number
  readonly token: string
  /** Built UI directory served at `/`; omitted serves a short notice. */
  readonly staticDir?: string
  /** Extra `host[:port]` authorities accepted in Host/Origin beyond loopback. */
  readonly trustedHosts: readonly string[]
  readonly sockets: Sockets
}

/** The protocol's WebSocket endpoint, shared by the own port and dsh's web server. */
export interface Sockets {
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  close(): Promise<void>
}

export function createSockets(onSocket: (socket: WebSocket) => void): Sockets {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  return {
    upgrade: (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => onSocket(ws)),
    close: () => new Promise<void>(done => {
      for (const client of wss.clients) client.close(1001, 'gateway stopping')
      wss.close(() => done())
    }),
  }
}

const RPC_PATH = '/rpc'

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || h.startsWith('127.') || h.endsWith('.localhost')
}

function authorityAllowed(authority: string | undefined, trusted: readonly string[]): boolean {
  if (authority === undefined || authority === '') return false
  let url: URL
  try {
    url = new URL(`http://${authority}`)
  } catch {
    return false
  }
  if (isLoopbackHost(url.hostname)) return true
  return trusted.some(entry => entry.includes(':') && !entry.startsWith('[')
    ? entry.toLowerCase() === url.host.toLowerCase()
    : entry.toLowerCase() === url.hostname.toLowerCase())
}

function tokenMatches(expected: string, given: string | null): boolean {
  if (given === null) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Answer a request under dsh's web server: the UI at `MOUNT/` (its assets
 * are relative, so the bare mount redirects to the trailing slash).
 */
export function serveMounted(root: string | undefined, req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? '/', 'http://local').pathname
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  if (pathname === MOUNT) {
    res.writeHead(308, { location: `${MOUNT}/` }).end()
    return
  }
  if (root === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('这个安装没有带界面')
    return
  }
  serveStatic(resolve(root), req, res, pathname.slice(MOUNT.length))
}

function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, path?: string): void {
  const pathname = decodeURIComponent(path ?? new URL(req.url ?? '/', 'http://local').pathname)
  const target = normalize(join(root, pathname))
  const inside = target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
  let file = inside ? target : join(root, 'index.html')
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html')
    statSync(file)
  } catch {
    file = join(root, 'index.html') // SPA fallback
  }
  try {
    const size = statSync(file).size
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-length': size,
      'cache-control': extname(file) === '.html' ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    })
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404).end('not found')
  }
}

/**
 * Start listening.
 * @returns the bound server and its resolved port.
 */
export async function startServer(options: ServerOptions): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const staticRoot = options.staticDir === undefined ? undefined : resolve(options.staticDir)

  const server = createServer((req, res) => {
    if (!authorityAllowed(req.headers.host, options.trustedHosts)) {
      res.writeHead(403).end('forbidden host')
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://local').pathname
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    if (staticRoot !== undefined) {
      serveStatic(staticRoot, req, res)
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      .end(`adg gateway: connect a client to ws://${req.headers.host}${RPC_PATH}?token=…\n`)
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://local')
    const origin = req.headers.origin
    const reject = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    if (url.pathname !== RPC_PATH) return reject(404, 'Not Found')
    if (!authorityAllowed(req.headers.host, options.trustedHosts)) return reject(403, 'Forbidden')
    // Browsers always send Origin; native clients usually omit it.
    if (origin !== undefined && origin !== 'null') {
      let originHost: string | undefined
      try {
        originHost = new URL(origin).host
      } catch {
        return reject(403, 'Forbidden')
      }
      if (!authorityAllowed(originHost, options.trustedHosts)) return reject(403, 'Forbidden')
    }
    if (!tokenMatches(options.token, url.searchParams.get('token'))) return reject(401, 'Unauthorized')
    options.sockets.upgrade(req, socket, head)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port, options.host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const port = (server.address() as AddressInfo).port

  return {
    server,
    port,
    close: () => new Promise<void>(done => {
      server.close(() => done())
      server.closeAllConnections()
    }),
  }
}
