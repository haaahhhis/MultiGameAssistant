/**
 * A fake Feishu Open Platform: the REST calls the bot makes (tenant token,
 * bot info, send / patch / reply, image upload) and the long connection the
 * official SDK opens (`/callback/ws/endpoint`, then protobuf frames over a
 * WebSocket). Tests play the person on the other side: `sendMessage` pushes
 * an `im.message.receive_v1` event, `clickCard` a `card.action.trigger` and
 * resolves with the bot's answer (its toast). Everything the bot sends is
 * recorded in `messages`.
 */
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

export interface FakeFeishuRequest {
  readonly method: string
  readonly path: string
  readonly query: Record<string, string>
  readonly body: unknown
  readonly authorization?: string
}

/** A message the bot sent: a new one, a reply, or a patch of an earlier card. */
export interface FakeFeishuMessage {
  readonly kind: 'create' | 'reply' | 'patch'
  readonly id: string
  /** open_id or chat_id it went to (create). */
  readonly to?: string
  /** The message replied to (reply). */
  readonly parentId?: string
  readonly msgType?: string
  readonly content: unknown
  /** Text of a text message, or every plain_text in a card. */
  readonly text: string
}

export interface FakeFeishu {
  readonly url: string
  readonly requests: FakeFeishuRequest[]
  readonly messages: FakeFeishuMessage[]
  /** Paths (without query) answered with 99991672 "no permission". */
  readonly deny: Set<string>
  /** A bot is on the long connection. */
  connected(): boolean
  /** The person writes to the bot. @returns the message id. */
  sendMessage(input: { openId: string; text: string; chatType?: 'p2p' | 'group'; parentId?: string; mentionBot?: boolean }): Promise<string>
  /** The person presses a card button. @returns what the bot answered (e.g. `{ toast }`). */
  clickCard(input: { openId: string; value: Record<string, unknown>; messageId?: string; name?: string }): Promise<unknown>
  /** Wait until a sent message matches. */
  waitForMessage(match: (message: FakeFeishuMessage) => boolean, timeoutMs?: number): Promise<FakeFeishuMessage>
  close(): Promise<void>
}

export async function startFakeFeishu(options: { appId?: string; appSecret?: string; port?: number } = {}): Promise<FakeFeishu> {
  const appSecret = options.appSecret ?? 'secret-ok'
  const requests: FakeFeishuRequest[] = []
  const messages: FakeFeishuMessage[] = []
  const deny = new Set<string>()
  const waiters = new Set<() => void>()
  const pendingAnswers = new Map<string, (value: unknown) => void>()
  let socket: WebSocket | undefined
  let seq = 0
  const record = (message: FakeFeishuMessage) => {
    messages.push(message)
    for (const wake of waiters) wake()
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const raw = await readBody(req)
      const type = req.headers['content-type'] ?? ''
      const body = type.includes('application/json') ? safeJson(raw.toString('utf8')) : { bytes: raw.length, multipart: type.includes('multipart') }
      requests.push({ method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), body, ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }) })
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (deny.has(url.pathname)) return send(400, { code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:message]' })
      const path = url.pathname
      const b = body as { app_secret?: string; AppSecret?: string; receive_id?: string; msg_type?: string; content?: string }
      if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
        return b.app_secret === appSecret ? send(200, { code: 0, msg: 'ok', tenant_access_token: 't-fake', expire: 7200 }) : send(200, { code: 10014, msg: 'app secret invalid' })
      }
      if (path === '/callback/ws/endpoint') {
        if (b.AppSecret !== appSecret) return send(200, { code: 1000040350, msg: 'app secret invalid', data: {} })
        const { port } = server.address() as AddressInfo
        // Like the real URL, the ids are not the first parameter (the SDK parses the whole URL as a query string).
        return send(200, { code: 0, msg: 'ok', data: { URL: `ws://127.0.0.1:${port}/ws?fpid=1&device_id=fake-device&service_id=7`, ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 } } })
      }
      if (path === '/open-apis/bot/v3/info') return send(200, { code: 0, msg: 'ok', bot: { app_name: 'ADG 测试机器人', open_id: 'ou_bot', activate_status: 2 } })
      if (path === '/open-apis/im/v1/messages' && req.method === 'POST') {
        const id = `om_${++seq}`
        record({ kind: 'create', id, to: b.receive_id ?? '', msgType: b.msg_type ?? '', content: safeJson(b.content ?? ''), text: textOf(safeJson(b.content ?? '')) })
        return send(200, { code: 0, msg: 'success', data: { message_id: id } })
      }
      const reply = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(path)
      if (reply !== null) {
        const id = `om_${++seq}`
        record({ kind: 'reply', id, parentId: reply[1]!, msgType: b.msg_type ?? '', content: safeJson(b.content ?? ''), text: textOf(safeJson(b.content ?? '')) })
        return send(200, { code: 0, msg: 'success', data: { message_id: id } })
      }
      const patch = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(path)
      if (patch !== null && req.method === 'PATCH') {
        record({ kind: 'patch', id: patch[1]!, content: safeJson(b.content ?? ''), text: textOf(safeJson(b.content ?? '')) })
        return send(200, { code: 0, msg: 'success' })
      }
      if (path === '/open-apis/im/v1/images') return send(200, { code: 0, msg: 'success', data: { image_key: `img_${++seq}` } })
      send(404, { code: 404, msg: `fake feishu: no route ${req.method} ${path}` })
    })()
  })

  const wss = new WebSocketServer({ server, path: '/ws' })
  wss.on('connection', ws => {
    socket = ws
    ws.on('message', data => {
      const frame = decodeFrame(data as Buffer)
      const headers = Object.fromEntries(frame.headers.map(h => [h.key, h.value]))
      if (frame.method === 0 && headers['type'] === 'ping') {
        ws.send(encodeFrame({ ...frame, headers: [{ key: 'type', value: 'pong' }], payload: Buffer.from(JSON.stringify({ PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 })) }))
        return
      }
      if (frame.method === 1) {
        // The bot's answer to an event: { code, data: base64(JSON(handler result)) }.
        const answer = safeJson(frame.payload.toString('utf8')) as { code?: number; data?: string }
        const resolve = pendingAnswers.get(headers['message_id'] ?? '')
        pendingAnswers.delete(headers['message_id'] ?? '')
        resolve?.(answer.data === undefined ? { code: answer.code } : safeJson(Buffer.from(answer.data, 'base64').toString('utf8')))
      }
    })
    ws.on('close', () => { if (socket === ws) socket = undefined })
  })

  /** Push one event and wait for the bot to answer it. */
  const push = (eventType: string, event: unknown): Promise<unknown> => {
    const ws = socket
    if (ws === undefined) return Promise.reject(new Error('no bot on the long connection'))
    const messageId = `evt_${++seq}`
    const payload = Buffer.from(JSON.stringify({
      schema: '2.0',
      header: { event_id: messageId, event_type: eventType, create_time: String(Date.now()), token: '', app_id: options.appId ?? 'cli_test', tenant_key: 'fake-tenant' },
      event,
    }))
    const answered = new Promise<unknown>((resolve, reject) => {
      pendingAnswers.set(messageId, resolve)
      setTimeout(() => { if (pendingAnswers.delete(messageId)) reject(new Error(`no answer to ${eventType} within 10 s`)) }, 10_000).unref()
    })
    ws.send(encodeFrame({
      SeqID: seq, LogID: seq, service: 7, method: 1,
      headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: messageId }, { key: 'sum', value: '1' }, { key: 'seq', value: '0' }, { key: 'trace_id', value: `trace-${seq}` }],
      payload,
    }))
    return answered
  }

  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    messages,
    deny,
    connected: () => socket !== undefined,
    async sendMessage(input) {
      const id = `om_user_${++seq}`
      const group = input.chatType === 'group'
      const text = group && input.mentionBot !== false ? `@_user_1 ${input.text}` : input.text
      await push('im.message.receive_v1', {
        sender: { sender_id: { open_id: input.openId }, sender_type: 'user' },
        message: {
          message_id: id, chat_id: group ? 'oc_group' : 'oc_p2p', chat_type: input.chatType ?? 'p2p', message_type: 'text',
          content: JSON.stringify({ text }), create_time: String(Date.now()),
          ...(input.parentId === undefined ? {} : { parent_id: input.parentId, root_id: input.parentId }),
          ...(group && input.mentionBot !== false ? { mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'ADG 测试机器人' }] } : {}),
        },
      })
      return id
    },
    clickCard: input => push('card.action.trigger', {
      operator: { open_id: input.openId, ...(input.name === undefined ? {} : { name: input.name }) },
      action: { tag: 'button', value: input.value },
      context: { open_message_id: input.messageId ?? '', open_chat_id: 'oc_p2p' },
      token: 'card-token',
    }),
    waitForMessage(match, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = messages.find(match)
          if (found === undefined) return false
          waiters.delete(check)
          clearTimeout(timer)
          resolve(found)
          return true
        }
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error('fake feishu: the expected message never came')) }, timeoutMs)
        if (!check()) waiters.add(check)
      })
    },
    close: () => new Promise(resolve => {
      for (const client of wss.clients) client.terminate()
      wss.close()
      server.close(() => resolve())
    }),
  }
}

// ── pbbp2.Frame, the long connection's protobuf message ──────────────────

interface Frame {
  SeqID: number
  LogID: number
  service: number
  method: number
  headers: { key: string; value: string }[]
  payload: Buffer
}

function varint(value: number): Buffer {
  const bytes: number[] = []
  let v = BigInt(value)
  do {
    let byte = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) byte |= 0x80
    bytes.push(byte)
  } while (v > 0n)
  return Buffer.from(bytes)
}

const key = (field: number, wire: number) => varint((field << 3) | wire)
const bytesField = (field: number, data: Buffer) => Buffer.concat([key(field, 2), varint(data.length), data])

export function encodeFrame(frame: Frame): Buffer {
  return Buffer.concat([
    key(1, 0), varint(frame.SeqID), key(2, 0), varint(frame.LogID), key(3, 0), varint(frame.service), key(4, 0), varint(frame.method),
    ...frame.headers.map(h => bytesField(5, Buffer.concat([bytesField(1, Buffer.from(h.key)), bytesField(2, Buffer.from(h.value))]))),
    bytesField(8, frame.payload),
  ])
}

export function decodeFrame(data: Buffer): Frame {
  const frame: Frame = { SeqID: 0, LogID: 0, service: 0, method: 0, headers: [], payload: Buffer.alloc(0) }
  const fields = readFields(data)
  for (const [field, value] of fields) {
    if (typeof value === 'number') {
      if (field === 1) frame.SeqID = value
      else if (field === 2) frame.LogID = value
      else if (field === 3) frame.service = value
      else if (field === 4) frame.method = value
    } else if (field === 5) {
      const header = new Map(readFields(value))
      frame.headers.push({ key: (header.get(1) as Buffer | undefined)?.toString('utf8') ?? '', value: (header.get(2) as Buffer | undefined)?.toString('utf8') ?? '' })
    } else if (field === 8) {
      frame.payload = value
    }
  }
  return frame
}

function readFields(data: Buffer): [number, number | Buffer][] {
  const out: [number, number | Buffer][] = []
  let offset = 0
  const readVarint = () => {
    let result = 0n
    let shift = 0n
    for (;;) {
      const byte = data[offset++]!
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return Number(result)
      shift += 7n
    }
  }
  while (offset < data.length) {
    const tag = readVarint()
    const field = tag >> 3
    const wire = tag & 7
    if (wire === 0) out.push([field, readVarint()])
    else if (wire === 2) {
      const length = readVarint()
      out.push([field, data.subarray(offset, offset + length)])
      offset += length
    } else throw new Error(`unsupported protobuf wire type ${wire}`)
  }
  return out
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (typeof content !== 'object' || content === null) return ''
  const c = content as { text?: unknown }
  if (typeof c.text === 'string') return c.text
  const texts: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (typeof value === 'object' && value !== null) {
      const v = value as { tag?: unknown; content?: unknown }
      if (v.tag === 'plain_text' && typeof v.content === 'string') texts.push(v.content)
      for (const child of Object.values(value)) if (typeof child === 'object') walk(child)
    }
  }
  walk(content)
  return texts.join('\n')
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}
