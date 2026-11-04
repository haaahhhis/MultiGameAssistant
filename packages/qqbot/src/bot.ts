/**
 * The QQ channel (远程连接 → QQ 机器人): settings, connection and self-check;
 * notices and 助手's conversation out as text to the allowed people; their
 * direct messages in, answered as replies. What a message means is decided
 * by `@adg/notify` (a reply like "停止" acts on a notice, anything else goes
 * to 助手). QQ shows no markdown in plain messages and has no cards here, so
 * everything goes as text: approvals and the agent's questions too, to the
 * person whose conversation asks (a plain reply answers them; other
 * sessions' stay in the app).
 */
import type { ApprovalRequested, ChannelCheck, ChannelStatus, QQPending, QQSettings, QuestionRequested } from '@adg/protocol'
import { approvalText, questionText, replyPlain, type Actor, type Channel, type MirrorPost, type Notice, type Reply } from '@adg/notify'
import type { ConnectionState, QQApi, QQMessage } from './api.ts'

/** What the bot needs from `@adg/notify`. */
export interface NotifyPort {
  inbound(message: { actor: Actor; text: string }): Promise<Reply>
  /** The agent waits for this person's answer: their message goes at once, not after the one waiting for it. */
  waiting?(actor: Actor): boolean
}

export interface QQState {
  settings: QQSettings
  pending: QQPending[]
}

export interface BotOptions {
  readonly createApi: (credentials: { appId: string; secret: string }) => QQApi
  readonly secret: () => Promise<string | undefined>
  readonly load: () => Promise<QQState>
  readonly save: (state: QQState) => Promise<void>
  readonly notify: () => NotifyPort | undefined
  readonly changed: () => void
  readonly log: { info(message: string): void; warn(message: string): void }
  /** How long a reply may take before "收到，正在处理…" is sent. @default 4000 */
  readonly ackAfterMs?: number
  /** Waits before trying again after a start that did not connect; the last repeats. @default [5s, 15s, 30s, 1min, 5min] */
  readonly retryDelaysMs?: readonly number[]
}

export const DEFAULT_QQ: QQSettings = { enabled: false, allowedUsers: [] }

const KEEP_PENDING = 20
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 300_000]
/** A reply to a person's message is a passive message for an hour; later it goes as an active one. */
const PASSIVE_MS = 55 * 60_000

export class QQBot implements Channel {
  readonly id = 'qq'
  readonly name = 'QQ'
  readonly #options: BotOptions
  #state: QQState = { settings: DEFAULT_QQ, pending: [] }
  #api: QQApi | undefined
  #connection: ConnectionState = 'idle'
  #error: string | undefined
  #checks: ChannelCheck[] = []
  #secretConfigured = false
  readonly #queues = new Map<string, Promise<void>>()
  /** Approvals and questions asked of a person here: id → their user_openid. */
  readonly #asked = new Map<string, string>()
  #generation = 0
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #retries = 0

  constructor(options: BotOptions) {
    this.#options = options
  }

  get state(): Readonly<QQState> & { secretConfigured: boolean } {
    return { ...this.#state, secretConfigured: this.#secretConfigured }
  }

  async start(): Promise<void> {
    this.#state = await this.#options.load()
    await this.restart()
  }

  /** (Re)connect with the current settings and secret; runs the self-check. */
  async restart(): Promise<void> {
    const generation = ++this.#generation
    clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
    this.#api?.close()
    this.#api = undefined
    this.#connection = 'idle'
    this.#error = undefined
    const secret = await this.#options.secret().catch(() => undefined)
    this.#secretConfigured = secret !== undefined && secret !== ''
    const { settings } = this.#state
    if (!settings.enabled || settings.appId === undefined || !this.#secretConfigured) {
      this.#checks = this.#configChecks()
      this.#options.changed()
      return
    }
    const api = this.#options.createApi({ appId: settings.appId, secret: secret! })
    this.#api = api
    await this.check()
    if (generation !== this.#generation) return
    if (this.#checks.find(c => c.id === 'token')?.ok !== true) {
      this.#retryLater(generation)
      return
    }
    try {
      await api.connect({ message: event => this.#onMessage(event) }, (state, error) => {
        if (generation !== this.#generation) return
        this.#connection = state
        this.#error = error
        this.#setCheck('ws', state === 'connected' ? true : state === 'failed' ? false : null, state === 'failed' ? error : undefined)
        if (state === 'connected') this.#retries = 0
        this.#options.changed()
      })
    } catch (error) {
      this.#connection = 'failed'
      this.#error = message(error)
      this.#setCheck('ws', false, this.#error)
      this.#retryLater(generation)
    }
    this.#options.changed()
  }

  #retryLater(generation: number): void {
    if (generation !== this.#generation || this.#retryTimer !== undefined) return
    const delays = this.#options.retryDelaysMs ?? RETRY_DELAYS_MS
    if (delays.length === 0) return
    const delay = delays[Math.min(this.#retries, delays.length - 1)]!
    this.#retries++
    this.#options.log.info(`qq: not connected, trying again in ${Math.round(delay / 1000)}s`)
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      if (generation === this.#generation) void this.restart().catch(error => this.#options.log.warn(`qq reconnect failed: ${message(error)}`))
    }, delay)
    this.#retryTimer.unref?.()
  }

  stop(): void {
    this.#generation++
    clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
    this.#api?.close()
    this.#api = undefined
    this.#connection = 'idle'
  }

  // ── settings ──────────────────────────────────────────────────────────

  async configure(patch: { enabled?: boolean | undefined; appId?: string | null | undefined }): Promise<void> {
    const next: QQSettings = { ...this.#state.settings }
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    if (patch.appId !== undefined) { if (patch.appId === null || patch.appId === '') delete next.appId; else next.appId = patch.appId }
    const reconnect = next.enabled !== this.#state.settings.enabled || next.appId !== this.#state.settings.appId
    this.#state = { ...this.#state, settings: next }
    await this.#options.save(this.#state)
    if (reconnect) await this.restart()
    else this.#options.changed()
  }

  async allow(openId: string, name: string | undefined, now = Date.now()): Promise<void> {
    const users = this.#state.settings.allowedUsers.filter(u => u.openId !== openId)
    users.push({ openId, addedAt: now, ...(name === undefined || name === '' ? {} : { name }) })
    this.#state = { settings: { ...this.#state.settings, allowedUsers: users }, pending: this.#state.pending.filter(p => p.openId !== openId) }
    await this.#options.save(this.#state)
    this.#setCheck('users', true)
    this.#options.changed()
    await this.#api?.sendText(openId, '你已被允许使用 MultiGameAssistant 机器人：和助手的对话会同步到这里，脚本出问题时也会通知你。直接发消息就能让它干活，例如「现在什么状态」。').catch(() => {})
  }

  /** Take someone off the list, or dismiss them from the pending ones. */
  async remove(openId: string): Promise<void> {
    this.#state = {
      settings: { ...this.#state.settings, allowedUsers: this.#state.settings.allowedUsers.filter(u => u.openId !== openId) },
      pending: this.#state.pending.filter(p => p.openId !== openId),
    }
    await this.#options.save(this.#state)
    this.#options.changed()
  }

  // ── status and self-check ─────────────────────────────────────────────

  status(): ChannelStatus {
    const { settings } = this.#state
    const configured = settings.appId !== undefined && this.#secretConfigured
    const state: ChannelStatus['state'] = !settings.enabled || !configured ? 'off'
      : this.#connection === 'connected' ? 'ready'
        : this.#connection === 'failed' || this.#checks.some(c => c.ok === false && c.id !== 'users') ? 'error'
          : this.#api === undefined ? 'off' : 'connecting'
    const detail = !settings.enabled ? '填写 AppID 和 AppSecret，保存后启用'
      : !configured ? '还没有填写 AppID 和 AppSecret'
        : this.#error ?? this.#checks.find(c => c.ok === false)?.detail
    return { id: this.id, name: this.name, state, ...(detail === undefined ? {} : { detail }), recipients: settings.allowedUsers.length, checks: this.#checks }
  }

  /** Credentials, the gateway, recipients. */
  async check(): Promise<ChannelCheck[]> {
    const checks = this.#configChecks()
    const api = this.#api
    if (api !== undefined) {
      try {
        await api.token()
        put(checks, 'token', true, '凭证有效')
      } catch (error) {
        put(checks, 'token', false, message(error))
      }
      const state = api.connectionState()
      put(checks, 'ws', state === 'connected' ? true : state === 'failed' ? false : null, state === 'connected' ? '已连接' : state === 'failed' ? this.#error ?? '连接失败' : '正在连接…')
    }
    this.#checks = checks
    this.#options.changed()
    return checks
  }

  #configChecks(): ChannelCheck[] {
    const { settings } = this.#state
    const configured = settings.appId !== undefined && this.#secretConfigured
    const people = settings.allowedUsers.length > 0
    return [
      { id: 'config', label: 'AppID 与 AppSecret', ok: configured, ...(configured ? {} : { detail: settings.appId === undefined ? '填写 AppID' : '填写 AppSecret' }) },
      { id: 'token', label: '凭证有效', ok: null },
      { id: 'ws', label: '消息连接（WebSocket）', ok: null },
      { id: 'users', label: '已允许的用户', ok: people, ...(people ? {} : { detail: '在 QQ 里给机器人发一条消息，然后在下面「待允许」里允许自己' }) },
    ]
  }

  #setCheck(id: string, ok: boolean | null, detail?: string): void {
    put(this.#checks, id, ok, detail)
  }

  // ── out ───────────────────────────────────────────────────────────────

  async send(notice: Notice): Promise<void> {
    const api = this.#ready()
    const people = this.#state.settings.allowedUsers
    if (people.length === 0) throw new Error('还没有允许任何 QQ 用户')
    const errors: string[] = []
    let delivered = 0
    for (const { openId } of people) {
      try {
        await api.sendText(openId, noticeText(notice))
        delivered++
      } catch (error) {
        errors.push(message(error))
      }
    }
    if (delivered === 0) throw new Error(errors[0] ?? '没有发出去')
  }

  async sendTo(openId: string, notice: Notice): Promise<void> {
    if (!this.#allowed(openId)) throw new Error('这个 QQ 用户没有被允许')
    await this.#ready().sendText(openId, noticeText(notice))
  }

  /** 助手's conversation, to each allowed person but `except`. */
  async mirror(post: MirrorPost, except: string | undefined): Promise<void> {
    const api = this.#ready()
    for (const { openId } of this.#state.settings.allowedUsers) {
      if (openId === except) continue
      await api.sendText(openId, post.markdown === true ? plainText(post.text) : post.text)
    }
  }

  /** A conversation's approvals, to its person only, as text; other sessions' stay in the app. */
  readonly approvals = {
    active: (owner: string | undefined) => owner !== undefined && this.#connection === 'connected' && this.#allowed(owner),
    ask: async (request: ApprovalRequested, owner: string | undefined) => {
      await this.#ready().sendText(owner!, approvalText(request))
      this.#asked.set(request.approvalId, owner!)
    },
    resolved: async (approvalId: string, outcome: string) => this.#settled(approvalId, outcome === 'cancelled' ? 'agent 已取消这个操作' : outcome === 'unavailable' ? '这个确认已失效' : undefined),
  }

  /** The agent's questions, routed like approvals. */
  readonly questions = {
    active: (owner: string | undefined) => this.approvals.active(owner),
    ask: async (request: QuestionRequested, owner: string | undefined) => {
      await this.#ready().sendText(owner!, questionText(request))
      this.#asked.set(request.questionId, owner!)
    },
    resolved: async (questionId: string, outcome: string) => this.#settled(questionId, outcome === 'cancelled' ? 'agent 不再等这个回答了' : outcome === 'unavailable' ? '这个问题已失效' : undefined),
  }

  /** An approval or question is over: say so when it ended without an answer (an answer's reply says itself). */
  async #settled(id: string, note: string | undefined): Promise<void> {
    const owner = this.#asked.get(id)
    this.#asked.delete(id)
    if (owner === undefined || note === undefined || this.#api === undefined) return
    await this.#api.sendText(owner, `（${note}）`).catch(() => {})
  }

  #ready(): QQApi {
    if (this.#api === undefined || this.#connection !== 'connected') throw new Error(this.status().detail ?? 'QQ 机器人还没有连接')
    return this.#api
  }

  #allowed(openId: string): boolean {
    return this.#state.settings.allowedUsers.some(u => u.openId === openId)
  }

  // ── in ────────────────────────────────────────────────────────────────

  #onMessage(event: QQMessage): void {
    const api = this.#api
    if (api === undefined) return
    if (!this.#allowed(event.openId)) {
      void this.#rememberStranger(event)
      void api.sendText(event.openId, `你还没有被允许使用这个机器人。\n你的 user_openid：${event.openId}\n请在 MultiGameAssistant 的「设置 → 远程连接 → QQ 机器人」里允许你自己。`, { msgId: event.id, seq: 1 }).catch(() => {})
      return
    }
    if (event.text === '') {
      void api.sendText(event.openId, '目前只看得懂文字消息。', { msgId: event.id, seq: 1 }).catch(() => {})
      return
    }
    // One person's messages are handled in order. An answer the agent waits for goes at once: the message before it is waiting for it.
    if (this.#options.notify()?.waiting?.(this.#actor(event)) === true) {
      void this.#answer(api, event).catch(error => this.#options.log.warn(`qq reply failed: ${message(error)}`))
      return
    }
    const previous = this.#queues.get(event.openId) ?? Promise.resolve()
    const next = previous.then(() => this.#answer(api, event)).catch(error => this.#options.log.warn(`qq reply failed: ${message(error)}`))
    this.#queues.set(event.openId, next)
    void next.then(() => { if (this.#queues.get(event.openId) === next) this.#queues.delete(event.openId) })
  }

  async #answer(api: QQApi, event: QQMessage): Promise<void> {
    const notify = this.#options.notify()
    const started = Date.now()
    let seq = 0
    // A reply to the message while QQ still takes it as one; after that, an active message.
    const reply = (text: string) => api.sendText(event.openId, text, Date.now() - started < PASSIVE_MS ? { msgId: event.id, seq: ++seq } : undefined)
    if (notify === undefined) {
      await reply('消息服务没有加载。')
      return
    }
    let answered = false
    const ack = setTimeout(() => { if (!answered) void reply('收到，正在处理…').catch(() => {}) }, this.#options.ackAfterMs ?? 4000)
    try {
      const answer = await notify.inbound({ actor: this.#actor(event), text: event.text })
      answered = true
      await reply(plainText(replyPlain(answer))).catch(() => api.sendText(event.openId, plainText(replyPlain(answer))))
    } catch (error) {
      answered = true
      await reply(`出错了：${message(error)}`).catch(() => {})
    } finally {
      clearTimeout(ack)
    }
  }

  #actor(event: QQMessage): Actor {
    const shown = this.#state.settings.allowedUsers.find(u => u.openId === event.openId)?.name ?? event.name
    return { channel: this.id, userId: event.openId, ...(shown === undefined ? {} : { name: shown }) }
  }

  async #rememberStranger(event: QQMessage): Promise<void> {
    const pending = [{ openId: event.openId, at: Date.now(), text: event.text.slice(0, 100) }, ...this.#state.pending.filter(p => p.openId !== event.openId)].slice(0, KEEP_PENDING)
    this.#state = { ...this.#state, pending }
    await this.#options.save(this.#state).catch(() => {})
    this.#options.changed()
  }
}

/** A notice as one text message: its title, then its text, then what to reply to act on it. */
export function noticeText(notice: Notice): string {
  const actions = notice.actions ?? []
  return [
    `【${notice.title}】`,
    notice.text,
    ...(notice.image === undefined ? [] : ['（截图在软件里）']),
    ...(actions.length === 0 ? [] : [`回复「${actions.map(a => a.label).join('」「')}」处理`]),
  ].join('\n')
}

/** Markdown read as text QQ shows well: no emphasis or heading marks; links keep their address. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) => `${alt === '' ? '图片' : alt}：${url}`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, text: string, url: string) => (url.startsWith('#') ? text : `${text}（${url}）`))
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function put(checks: ChannelCheck[], id: string, ok: boolean | null, detail?: string): void {
  const check = checks.find(c => c.id === id)
  if (check === undefined) return
  check.ok = ok
  if (detail === undefined) delete check.detail
  else check.detail = detail
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
