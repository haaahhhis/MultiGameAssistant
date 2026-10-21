/**
 * The Feishu Open Platform calls the bot uses, behind one interface so tests
 * can run the bot against a fake. The real implementation uses the official
 * SDK: REST through `Client`, events and card callbacks through the long
 * connection (`WSClient`), so no public address is needed.
 */
import { Readable } from 'node:stream'
import * as lark from '@larksuiteoapi/node-sdk'
import { markdownPost } from './markdown.ts'

/** Where a message goes: a person (p2p) or a group chat. */
export type Target = { readonly openId: string } | { readonly chatId: string }

export interface InboundMessage {
  readonly messageId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group' | string
  readonly senderOpenId: string
  /** Plain text with @-mention placeholders removed. */
  readonly text: string
  readonly messageType: string
  /** The message this one replies to. */
  readonly parentId?: string
  /** The bot was @-mentioned (group chats). */
  readonly mentionsBot: boolean
}

export interface CardAction {
  readonly operatorOpenId: string
  readonly operatorName?: string
  readonly messageId?: string
  readonly value: Record<string, unknown>
}

/** What a card callback answers within Feishu's 3 seconds: a toast, optionally a replacement card. */
export interface CardActionResponse {
  readonly toast?: { readonly type: 'success' | 'info' | 'warning' | 'error'; readonly content: string }
  readonly card?: object
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

export interface FeishuApi {
  /** @throws FeishuError when the App ID / Secret are wrong. */
  token(): Promise<void>
  botInfo(): Promise<{ name: string; openId: string }>
  sendCard(to: Target, card: object): Promise<string>
  patchCard(messageId: string, card: object): Promise<void>
  sendText(to: Target, text: string): Promise<string>
  replyText(messageId: string, text: string): Promise<string>
  /** Reply with markdown rendered (rich text with an `md` block). */
  replyMarkdown(messageId: string, markdown: string): Promise<string>
  uploadImage(png: Buffer): Promise<string>
  /** Open the long connection; handlers run for each event. */
  connect(handlers: { message(event: InboundMessage): void; cardAction(event: CardAction): Promise<CardActionResponse | undefined> }, onState: (state: ConnectionState, error?: string) => void): Promise<void>
  connectionState(): ConnectionState
  close(): void
}

/** A Feishu API error with the platform's code and a hint for people. */
export class FeishuError extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'FeishuError'
    this.code = code
  }
}

/** Hints for the error codes people actually hit while setting up an app. */
const HINTS: Readonly<Record<number, string>> = {
  10003: 'App ID 或 App Secret 不对',
  10014: 'App Secret 不对',
  99991663: 'App ID 或 App Secret 不对，或应用已停用',
  99991664: 'App ID 或 App Secret 不对',
  99991672: '应用缺少权限：在开发者后台「权限管理」开通后，需要发布一个新版本才生效',
  99991401: '请求来源 IP 不在应用的白名单里',
  230001: '参数不对（消息内容或卡片格式）',
  230002: '机器人不在这个群里',
  230006: '应用没有开启机器人能力：开发者后台「添加应用能力 → 机器人」',
  230013: '这个用户不在应用的可用范围内：在「版本管理与发布」里把可用范围设为该用户或全员，并发布',
  230020: '发送太频繁，被限流了',
  234001: '图片格式不支持',
  234006: '图片太大（上限 10 MB）',
}

export function describeFeishuError(error: unknown): FeishuError {
  if (error instanceof FeishuError) return error
  const response = (error as { response?: { data?: { code?: number; msg?: string }; status?: number } } | null)?.response
  const code = response?.data?.code
  const msg = response?.data?.msg ?? (error instanceof Error ? error.message : String(error))
  const hint = code === undefined ? undefined : HINTS[code]
  return new FeishuError(hint === undefined ? `飞书接口出错：${msg}${code === undefined ? '' : `（${code}）`}` : `${hint}（${code}：${msg}）`, code)
}

function check<T extends { code?: number | undefined; msg?: string | undefined }>(result: T, what: string): T {
  if (result.code !== undefined && result.code !== 0) {
    throw describeFeishuError({ response: { data: { code: result.code, msg: `${what}：${result.msg ?? ''}` } } })
  }
  return result
}

export interface SdkOptions {
  readonly appId: string
  readonly appSecret: string
  /** `feishu`, `lark`, or a base URL (tests). */
  readonly domain: 'feishu' | 'lark' | string
  readonly log: { info(message: string): void; warn(message: string): void }
}

/** The real API over `@larksuiteoapi/node-sdk`. */
export function sdkApi(options: SdkOptions): FeishuApi {
  const domain = options.domain === 'feishu' ? lark.Domain.Feishu : options.domain === 'lark' ? lark.Domain.Lark : options.domain
  const logger = {
    error: (...m: unknown[]) => options.log.warn(`[feishu] ${m.map(String).join(' ')}`),
    warn: (...m: unknown[]) => options.log.warn(`[feishu] ${m.map(String).join(' ')}`),
    info: (...m: unknown[]) => options.log.info(`[feishu] ${m.map(String).join(' ')}`),
    debug: () => {},
    trace: () => {},
  }
  const client = new lark.Client({ appId: options.appId, appSecret: options.appSecret, domain, logger, loggerLevel: lark.LoggerLevel.warn })
  let ws: lark.WSClient | undefined
  const receive = (to: Target) => ('openId' in to ? { receive_id_type: 'open_id' as const, receive_id: to.openId } : { receive_id_type: 'chat_id' as const, receive_id: to.chatId })
  const call = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      const described = describeFeishuError(error)
      throw new FeishuError(`${what}失败：${described.message}`, described.code)
    }
  }

  return {
    async token() {
      await call('获取访问凭证', async () => {
        const result = await client.auth.tenantAccessToken.internal({ data: { app_id: options.appId, app_secret: options.appSecret } }) as { code?: number; msg?: string }
        check(result, '获取 tenant_access_token')
      })
    },
    async botInfo() {
      return call('读取机器人信息', async () => {
        const result = check(await client.request<{ code?: number; msg?: string; bot?: { app_name?: string; open_id?: string } }>({ method: 'GET', url: '/open-apis/bot/v3/info' }), '读取机器人信息')
        return { name: result.bot?.app_name ?? '', openId: result.bot?.open_id ?? '' }
      })
    },
    async sendCard(to, card) {
      return call('发送消息', async () => {
        const { receive_id_type, receive_id } = receive(to)
        const result = check(await client.im.message.create({ params: { receive_id_type }, data: { receive_id, msg_type: 'interactive', content: JSON.stringify(card) } }), '发送卡片')
        return result.data?.message_id ?? ''
      })
    },
    async patchCard(messageId, card) {
      await call('更新消息', async () => {
        check(await client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } }), '更新卡片')
      })
    },
    async sendText(to, text) {
      return call('发送消息', async () => {
        const { receive_id_type, receive_id } = receive(to)
        const result = check(await client.im.message.create({ params: { receive_id_type }, data: { receive_id, msg_type: 'text', content: JSON.stringify({ text }) } }), '发送文字')
        return result.data?.message_id ?? ''
      })
    },
    async replyText(messageId, text) {
      return call('回复消息', async () => {
        const result = check(await client.im.message.reply({ path: { message_id: messageId }, data: { msg_type: 'text', content: JSON.stringify({ text }) } }), '回复')
        return result.data?.message_id ?? ''
      })
    },
    async replyMarkdown(messageId, markdown) {
      return call('回复消息', async () => {
        const result = check(await client.im.message.reply({ path: { message_id: messageId }, data: { msg_type: 'post', content: JSON.stringify(markdownPost(markdown)) } }), '回复')
        return result.data?.message_id ?? ''
      })
    },
    async uploadImage(png) {
      return call('上传图片', async () => {
        // A plain Buffer goes up without a filename, and Feishu then does not see a file; a named stream does.
        const image = Object.assign(Readable.from([png]), { path: 'screenshot.png' }) as unknown as import('node:fs').ReadStream
        const result = await client.im.image.create({ data: { image_type: 'message', image } }) as { image_key?: string; code?: number; msg?: string; data?: { image_key?: string } } | null
        const key = result?.image_key ?? result?.data?.image_key
        if (key === undefined) throw new FeishuError(`上传图片没有返回 image_key${result?.code === undefined ? '' : `（${result.code}：${result.msg ?? ''}）`}`, result?.code)
        return key
      })
    },
    async connect(handlers, onState) {
      ws?.close({ force: true })
      // The SDK only logs a malformed App ID and never connects.
      if (!/^cli_[0-9a-fA-F]{16}$/.test(options.appId)) {
        onState('failed', `App ID 格式不对（${options.appId}），应为 cli_ 加 16 位字母数字`)
        return
      }
      onState('connecting')
      ws = new lark.WSClient({
        appId: options.appId, appSecret: options.appSecret, domain, logger, loggerLevel: lark.LoggerLevel.warn, autoReconnect: true,
        onReady: () => onState('connected'),
        onReconnecting: () => onState('reconnecting'),
        onReconnected: () => onState('connected'),
        onError: error => onState('failed', describeFeishuError(error).message),
      })
      const dispatcher = new lark.EventDispatcher({ logger, loggerLevel: lark.LoggerLevel.warn }).register({
        'im.message.receive_v1': async (data: unknown) => {
          const event = parseMessage(data)
          if (event !== undefined) handlers.message(event)
        },
        'card.action.trigger': async (data: unknown) => {
          const event = parseCardAction(data)
          if (event === undefined) return undefined
          const response = await handlers.cardAction(event)
          if (response === undefined) return undefined
          return {
            ...(response.toast === undefined ? {} : { toast: response.toast }),
            ...(response.card === undefined ? {} : { card: { type: 'raw', data: response.card } }),
          }
        },
      } as never)
      await ws.start({ eventDispatcher: dispatcher })
    },
    connectionState() {
      return ws?.getConnectionStatus().state ?? 'idle'
    },
    close() {
      ws?.close({ force: true })
      ws = undefined
    },
  }
}

/** `im.message.receive_v1` → InboundMessage (text messages and posts; others keep an empty text). */
export function parseMessage(data: unknown): InboundMessage | undefined {
  const d = data as {
    sender?: { sender_id?: { open_id?: string }; sender_type?: string }
    message?: { message_id?: string; chat_id?: string; chat_type?: string; message_type?: string; content?: string; parent_id?: string; mentions?: { key?: string; name?: string; id?: { open_id?: string } }[] }
  }
  const m = d.message
  const sender = d.sender?.sender_id?.open_id
  if (m?.message_id === undefined || sender === undefined || d.sender?.sender_type === 'app') return undefined
  let text = ''
  try {
    const content = JSON.parse(m.content ?? '{}') as { text?: string; content?: { tag?: string; text?: string }[][] }
    text = content.text ?? (content.content ?? []).flat().map(e => (e.tag === 'text' ? e.text ?? '' : '')).join('')
  } catch { /* not JSON: leave empty */ }
  const mentions = m.mentions ?? []
  for (const mention of mentions) if (mention.key !== undefined) text = text.split(mention.key).join('')
  return {
    messageId: m.message_id,
    chatId: m.chat_id ?? '',
    chatType: m.chat_type ?? 'p2p',
    senderOpenId: sender,
    text: text.trim(),
    messageType: m.message_type ?? 'text',
    ...(m.parent_id === undefined || m.parent_id === '' ? {} : { parentId: m.parent_id }),
    mentionsBot: mentions.length > 0,
  }
}

/** `card.action.trigger` (schema 2.0) → CardAction. */
export function parseCardAction(data: unknown): CardAction | undefined {
  const d = data as { operator?: { open_id?: string; name?: string }; action?: { value?: unknown }; context?: { open_message_id?: string }; open_message_id?: string }
  const operator = d.operator?.open_id
  const value = d.action?.value
  if (operator === undefined || typeof value !== 'object' || value === null) return undefined
  const messageId = d.context?.open_message_id ?? d.open_message_id
  return {
    operatorOpenId: operator,
    ...(d.operator?.name === undefined ? {} : { operatorName: d.operator.name }),
    ...(messageId === undefined ? {} : { messageId }),
    value: value as Record<string, unknown>,
  }
}
