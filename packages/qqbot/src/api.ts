/**
 * The QQ official bot's open API (bot.q.qq.com, API v2): an access token from
 * the AppID and AppSecret, direct messages out over HTTPS, and direct
 * messages in over the WebSocket gateway — so, like Feishu's long
 * connection, no public address is needed.
 *
 * - Token: POST /app/getAppAccessToken; valid about two hours, asked again a
 *   minute before it runs out.
 * - Gateway: GET /gateway gives the address; Hello → Identify (intents
 *   GROUP_AND_C2C_EVENT) → READY; heartbeats with the last sequence; after a
 *   drop, Resume with the session, else Identify again.
 * - Send: POST /v2/users/{openid}/messages, text (msg_type 0) or markdown
 *   (msg_type 2, open to every bot in direct messages), which may carry a
 *   keyboard of buttons. Ours are command buttons that send at once (action
 *   type 2, enter): pressing one sends its text as the person's message, so
 *   it is answered like a typed reply and needs no INTERACTION intent (which
 *   must be applied for; Identify fails without it). A reply carries the
 *   message's id and a sequence (several replies to one message); without
 *   them it is an active message, which a person may have turned off.
 */

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'failed'

/** A direct message to the bot. */
export interface QQMessage {
  readonly id: string
  /** The sender's user_openid (one per bot). */
  readonly openId: string
  readonly name?: string
  readonly text: string
}

/** A button under a message: pressing it sends `send` as the person's message. */
export interface QQButton {
  readonly label: string
  readonly send: string
  readonly primary?: boolean
}

/** A message out: text, or markdown with buttons in rows (at most 5 rows of 5). */
export interface QQOutgoing {
  readonly text: string
  readonly markdown?: boolean
  readonly buttons?: readonly (readonly QQButton[])[]
}

export interface QQApi {
  /** @throws QQError when the AppID / AppSecret are wrong. */
  token(): Promise<string>
  /** @returns the sent message's id. `reply`: the message answered and which answer to it this is (1, 2, …). */
  sendText(openId: string, text: string, reply?: { readonly msgId: string; readonly seq: number }): Promise<string>
  /** The same for any message: markdown, and buttons under it. @throws QQError when QQ does not take it (e.g. buttons the bot may not send). */
  sendMessage(openId: string, message: QQOutgoing, reply?: { readonly msgId: string; readonly seq: number }): Promise<string>
  /** Open the gateway; reconnects by itself after a drop. */
  connect(handlers: { message(event: QQMessage): void }, onState: (state: ConnectionState, error?: string) => void): Promise<void>
  connectionState(): ConnectionState
  close(): void
}

/** A QQ open platform error, with its code and a hint for people. */
export class QQError extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'QQError'
    this.code = code
  }
}

/** Hints for the codes people hit while setting up a bot. */
const HINTS: Readonly<Record<number, string>> = {
  100007: 'AppID 不对，或者机器人被封禁、删除了',
  100016: 'AppID 或 AppSecret 不对',
  10004: '没有这个机器人：检查 AppID',
  11241: '缺少凭证',
  11243: '凭证不对',
  11253: '机器人还没有这个接口的权限：在 QQ 开放平台申请',
  11265: '机器人已被封禁',
  40034005: '要回复的消息已经过期',
  22009: '消息发送太频繁，被限制了',
  40054005: '对方关闭了机器人的主动消息',
}

/** The gateway's close codes after which connecting again cannot help. */
const FATAL_CLOSE: Readonly<Record<number, string>> = {
  4004: '鉴权失败：AppID 或 AppSecret 不对',
  4013: '订阅的事件无效',
  4014: '机器人没有接收单聊消息的权限：在 QQ 开放平台开通「单聊」能力',
  4914: '机器人已下架，只能连接沙箱环境',
  4915: '机器人已被封禁',
}

/** GROUP_AND_C2C_EVENT: direct messages (C2C_MESSAGE_CREATE). */
const INTENTS = 1 << 25
const TOKEN_MARGIN_MS = 60_000
const RECONNECT_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000]
const SEEN_KEPT = 500

export interface HttpApiOptions {
  readonly appId: string
  readonly secret: string
  /** API base. @default https://api.bot.qq.com */
  readonly base?: string
  readonly fetch?: typeof fetch
  readonly WebSocket?: typeof WebSocket
  readonly now?: () => number
  readonly log: { info(message: string): void; warn(message: string): void }
}

export function httpApi(options: HttpApiOptions): QQApi {
  const base = (options.base ?? 'https://api.bot.qq.com').replace(/\/$/, '')
  const doFetch = options.fetch ?? fetch
  const Socket = options.WebSocket ?? WebSocket
  const now = options.now ?? Date.now
  let cached: { token: string; until: number } | undefined
  let state: ConnectionState = 'idle'
  let socket: WebSocket | undefined
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let session: { id: string; seq: number | null } | undefined
  let attempts = 0
  const seen = new Set<string>()

  const token = async (): Promise<string> => {
    if (cached !== undefined && now() < cached.until - TOKEN_MARGIN_MS) return cached.token
    const response = await doFetch(`${base}/app/getAppAccessToken`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: options.appId, clientSecret: options.secret }) })
    const body = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number | string; code?: number; message?: string }
    if (typeof body.access_token !== 'string' || body.access_token === '') throw platformError('获取凭证', body.code, body.message ?? `HTTP ${response.status}`)
    cached = { token: body.access_token, until: now() + Number(body.expires_in ?? 7200) * 1000 }
    return cached.token
  }

  const request = async <T>(what: string, method: string, path: string, body?: unknown): Promise<T> => {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: { Authorization: `QQBot ${await token()}`, 'Content-Type': 'application/json; charset=utf-8' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    const parsed = (text === '' ? {} : JSON.parse(text)) as T & { err_code?: number; code?: number; message?: string }
    const code = parsed.err_code ?? (response.ok ? undefined : parsed.code)
    if (!response.ok || (code !== undefined && code !== 0)) throw platformError(what, code, parsed.message ?? `HTTP ${response.status}`)
    return parsed
  }

  const setState = (next: ConnectionState, error: string | undefined, onState: (state: ConnectionState, error?: string) => void) => {
    state = next
    onState(next, error)
  }

  const open = async (handlers: { message(event: QQMessage): void }, onState: (state: ConnectionState, error?: string) => void): Promise<void> => {
    if (closed) return
    setState('connecting', undefined, onState)
    const { url } = await request<{ url: string }>('获取连接地址', 'GET', '/gateway')
    const ws = new Socket(url)
    socket = ws
    const send = (payload: object) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload)) }
    ws.addEventListener('message', event => {
      let payload: { op?: number; d?: unknown; s?: number; t?: string }
      try { payload = JSON.parse(String(event.data)) as typeof payload } catch { return }
      if (typeof payload.s === 'number' && session !== undefined) session.seq = payload.s
      if (payload.op === 10) {
        const interval = Number((payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 41_250)
        clearInterval(heartbeat)
        heartbeat = setInterval(() => send({ op: 1, d: session?.seq ?? null }), interval)
        heartbeat.unref?.()
        void token().then(t => {
          if (session !== undefined) send({ op: 6, d: { token: `QQBot ${t}`, session_id: session.id, seq: session.seq } })
          else send({ op: 2, d: { token: `QQBot ${t}`, intents: INTENTS, shard: [0, 1], properties: {} } })
        }, error => { setState('failed', messageOf(error), onState); ws.close() })
      } else if (payload.op === 0 && payload.t === 'READY') {
        session = { id: String((payload.d as { session_id?: string }).session_id ?? ''), seq: payload.s ?? null }
        attempts = 0
        setState('connected', undefined, onState)
      } else if (payload.op === 0 && payload.t === 'RESUMED') {
        attempts = 0
        setState('connected', undefined, onState)
      } else if (payload.op === 0 && payload.t === 'C2C_MESSAGE_CREATE') {
        const d = payload.d as { id?: string; content?: string; author?: { user_openid?: string; id?: string; username?: string } }
        const id = String(d.id ?? '')
        const openId = d.author?.user_openid ?? d.author?.id ?? ''
        // The same message may come twice (and again after a resume).
        if (id === '' || openId === '' || seen.has(id)) return
        seen.add(id)
        if (seen.size > SEEN_KEPT) seen.delete(seen.values().next().value!)
        handlers.message({ id, openId, text: (d.content ?? '').trim(), ...(d.author?.username ? { name: d.author.username } : {}) })
      } else if (payload.op === 7) {
        ws.close(4009)
      } else if (payload.op === 9) {
        // The session cannot be resumed: identify again on the next connection.
        session = undefined
        ws.close(4006)
      }
    })
    ws.addEventListener('close', event => {
      clearInterval(heartbeat)
      if (socket !== ws || closed) return
      const fatal = FATAL_CLOSE[event.code]
      if (fatal !== undefined) {
        setState('failed', fatal, onState)
        return
      }
      if (event.code === 4006 || event.code === 4007) session = undefined
      setState('connecting', undefined, onState)
      const delay = RECONNECT_DELAYS_MS[Math.min(attempts++, RECONNECT_DELAYS_MS.length - 1)]!
      options.log.info(`qq: gateway closed (${event.code}), connecting again in ${Math.round(delay / 1000)}s`)
      reconnectTimer = setTimeout(() => { void open(handlers, onState).catch(error => setState('failed', messageOf(error), onState)) }, delay)
      reconnectTimer.unref?.()
    })
    ws.addEventListener('error', () => { /* the close that follows says what to do */ })
  }

  const sendMessage = async (openId: string, message: QQOutgoing, reply?: { readonly msgId: string; readonly seq: number }): Promise<string> => {
    const body = message.markdown === true
      ? { msg_type: 2, markdown: { content: message.text }, ...(message.buttons === undefined || message.buttons.length === 0 ? {} : { keyboard: keyboardOf(message.buttons) }) }
      : { msg_type: 0, content: message.text }
    const sent = await request<{ id?: string }>('发送消息', 'POST', `/v2/users/${encodeURIComponent(openId)}/messages`, {
      ...body, ...(reply === undefined ? {} : { msg_id: reply.msgId, msg_seq: reply.seq }),
    })
    return sent.id ?? ''
  }

  return {
    token,
    sendText: (openId, text, reply) => sendMessage(openId, { text }, reply),
    sendMessage,
    async connect(handlers, onState) {
      closed = false
      await open(handlers, onState)
    },
    connectionState: () => state,
    close() {
      closed = true
      clearInterval(heartbeat)
      clearTimeout(reconnectTimer)
      socket?.close()
      socket = undefined
      session = undefined
      state = 'idle'
    },
  }
}

/** Our buttons as QQ's custom keyboard: command buttons anyone in the chat may press, sending at once. */
export function keyboardOf(rows: readonly (readonly QQButton[])[]): object {
  return {
    content: {
      rows: rows.slice(0, 5).map((row, r) => ({
        buttons: row.slice(0, 5).map((button, i) => ({
          id: `${r}-${i}`,
          render_data: { label: button.label, visited_label: button.label, style: button.primary === true ? 1 : 0 },
          action: { type: 2, permission: { type: 2 }, data: button.send, enter: true, unsupport_tips: `请直接回复「${button.send}」` },
        })),
      })),
    },
  }
}

function platformError(what: string, code: number | undefined, detail: string): QQError {
  const hint = code === undefined ? undefined : HINTS[code]
  return new QQError(`${what}失败：${hint ?? detail}${code === undefined ? '' : `（${code}）`}`, code)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
