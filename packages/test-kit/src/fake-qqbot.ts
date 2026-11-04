/**
 * A fake QQ bot open platform (API v2), enough for the QQ channel: the
 * access token, the gateway address, the WebSocket gateway (Hello, Identify,
 * READY, heartbeats, Resume) and direct messages both ways.
 */
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

export interface FakeQQSent {
  readonly openId: string
  readonly text: string
  readonly msgId?: string
  readonly seq?: number
}

export async function startFakeQQ(options: { appId: string; secret: string; port?: number }) {
  const sent: FakeQQSent[] = []
  const identified: { intents: number }[] = []
  const resumed: string[] = []
  const waiters: { match: (m: FakeQQSent) => boolean; resolve: (m: FakeQQSent) => void }[] = []
  let socket: WebSocket | undefined
  let seq = 0
  let messages = 0
  const token = `tok-${options.appId}`

  const read = (req: IncomingMessage) => new Promise<string>(resolve => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => resolve(body))
  })

  const server = createServer(async (req, res) => {
    const reply = (status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/app/getAppAccessToken') {
      const body = JSON.parse(await read(req)) as { appId?: string; clientSecret?: string }
      if (body.appId !== options.appId || body.clientSecret !== options.secret) return reply(200, { code: 100016, message: 'invalid appid or secret' })
      return reply(200, { access_token: token, expires_in: '7200' })
    }
    if (req.headers.authorization !== `QQBot ${token}`) return reply(401, { err_code: 11243, message: 'token invalid' })
    if (url.pathname === '/gateway') return reply(200, { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/websocket` })
    const to = /^\/v2\/users\/([^/]+)\/messages$/.exec(url.pathname)
    if (to !== null && req.method === 'POST') {
      const body = JSON.parse(await read(req)) as { content?: string; msg_id?: string; msg_seq?: number }
      const message: FakeQQSent = { openId: decodeURIComponent(to[1]!), text: body.content ?? '', ...(body.msg_id === undefined ? {} : { msgId: body.msg_id }), ...(body.msg_seq === undefined ? {} : { seq: body.msg_seq }) }
      sent.push(message)
      for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message) }
      return reply(200, { id: `ROBOT1.0_${sent.length}`, timestamp: new Date().toISOString() })
    }
    reply(404, { err_code: 404, message: 'not found' })
  })
  const wss = new WebSocketServer({ server, path: '/websocket' })
  wss.on('connection', ws => {
    socket = ws
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
    ws.on('message', data => {
      const payload = JSON.parse(String(data)) as { op: number; d: { token?: string; intents?: number; session_id?: string } }
      if (payload.op === 2) {
        if (payload.d.token !== `QQBot ${token}`) { ws.close(4004); return }
        identified.push({ intents: payload.d.intents ?? 0 })
        ws.send(JSON.stringify({ op: 0, s: ++seq, t: 'READY', d: { version: 1, session_id: 'sess-1', user: { id: 'bot', username: 'ADG', bot: true }, shard: [0, 1] } }))
      } else if (payload.op === 6) {
        resumed.push(payload.d.session_id ?? '')
        ws.send(JSON.stringify({ op: 0, s: ++seq, t: 'RESUMED', d: '' }))
      } else if (payload.op === 1) {
        ws.send(JSON.stringify({ op: 11 }))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    base,
    sent,
    identified,
    resumed,
    connected: () => socket !== undefined && socket.readyState === socket.OPEN,
    /** A person's direct message to the bot; `repeat` sends the same message twice, as QQ may. @returns its id. */
    sendMessage(input: { openId: string; text: string; repeat?: boolean }): string {
      const id = `ROBOT1.0_in_${++messages}`
      const frame = JSON.stringify({ op: 0, s: ++seq, t: 'C2C_MESSAGE_CREATE', id: `C2C_MESSAGE_CREATE:${id}`, d: { id, content: input.text, author: { id: input.openId, user_openid: input.openId }, timestamp: new Date().toISOString() } })
      socket?.send(frame)
      if (input.repeat === true) socket?.send(frame)
      return id
    },
    /** Drop the connection the way the gateway does when it wants a reconnect. */
    drop(code = 4009) { socket?.close(code) },
    waitForMessage(match: (m: FakeQQSent) => boolean, timeoutMs = 5000): Promise<FakeQQSent> {
      const found = sent.find(match)
      if (found !== undefined) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no such QQ message in time')), timeoutMs)
        waiters.push({ match, resolve: m => { clearTimeout(timer); resolve(m) } })
      })
    },
    async close() {
      for (const client of wss.clients) client.terminate()
      wss.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
