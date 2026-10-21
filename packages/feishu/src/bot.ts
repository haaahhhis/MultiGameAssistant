/**
 * The Feishu channel: settings, connection and self-check; notices and
 * approval questions out as cards; messages and card clicks in, from allowed
 * people only. What a message means is decided by `@adg/notify` (a reply
 * like "停止" acts on a notice, anything else goes to the agent).
 */
import type { ApprovalRequested, ChannelCheck, ChannelStatus, FeishuPending, FeishuSettings } from '@adg/protocol'
import type { Actor, Channel, Notice, NoticePatch } from '@adg/notify'
import type { CardAction, CardActionResponse, ConnectionState, FeishuApi, InboundMessage, Target } from './api.ts'
import { approvalCard, noticeCard, OUTCOME } from './cards.ts'

/** What the bot needs from `@adg/notify`. */
export interface NotifyPort {
  act(noticeId: string, actionId: string, actor: Actor): Promise<string>
  inbound(message: { actor: Actor; text: string; replyTo?: string | undefined }): Promise<string>
  respondApproval(approvalId: string, decision: 'allow-once' | 'reject', actor: Actor): boolean
}

export interface FeishuState {
  settings: FeishuSettings
  pending: FeishuPending[]
}

export interface BotOptions {
  readonly createApi: (credentials: { appId: string; appSecret: string; domain: FeishuSettings['domain'] }) => FeishuApi
  readonly secret: () => Promise<string | undefined>
  readonly load: () => Promise<FeishuState>
  readonly save: (state: FeishuState) => Promise<void>
  readonly notify: () => NotifyPort | undefined
  readonly changed: () => void
  readonly log: { info(message: string): void; warn(message: string): void }
  /** How long a reply may take before "收到，正在处理…" is sent. @default 4000 */
  readonly ackAfterMs?: number
  /** How long a card click may run before the toast says it is still going. @default 2500 */
  readonly clickBudgetMs?: number
  /**
   * Waits before reconnecting by itself after a start that did not connect (the
   * network not up yet at logon, a timeout, the long connection dropping); the
   * last one repeats. @default [5s, 15s, 30s, 1min, 5min]
   */
  readonly retryDelaysMs?: readonly number[]
  /** How long the long connection may stay "connecting" before it is opened again. @default 45000 */
  readonly connectTimeoutMs?: number
}

export const DEFAULT_FEISHU: FeishuSettings = { enabled: false, domain: 'feishu', allowedUsers: [], otherApprovals: false }

interface Delivered {
  notice: Notice
  imageKey?: string
  messageIds: string[]
}

const KEEP_DELIVERED = 200
const KEEP_PENDING = 20
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 300_000]

export class FeishuBot implements Channel {
  readonly id = 'feishu'
  readonly name = '飞书'
  readonly #options: BotOptions
  #state: FeishuState = { settings: DEFAULT_FEISHU, pending: [] }
  #api: FeishuApi | undefined
  #connection: ConnectionState = 'idle'
  #error: string | undefined
  #checks: ChannelCheck[] = []
  #secretConfigured = false
  readonly #delivered = new Map<string, Delivered>()
  readonly #byMessage = new Map<string, string>()
  readonly #approvals = new Map<string, { request: ApprovalRequested; own: boolean; messageIds: string[] }>()
  readonly #queues = new Map<string, Promise<void>>()
  #generation = 0
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #retries = 0

  constructor(options: BotOptions) {
    this.#options = options
  }

  get state(): Readonly<FeishuState> & { secretConfigured: boolean } {
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
    const api = this.#options.createApi({ appId: settings.appId, appSecret: secret!, domain: settings.domain })
    this.#api = api
    await this.check()
    if (generation !== this.#generation) return
    if (this.#checks.find(c => c.id === 'token')?.ok !== true) {
      this.#retryLater(generation)
      return
    }
    try {
      await api.connect({
        message: event => this.#onMessage(event),
        cardAction: event => this.#onCardAction(event),
      }, (state, error) => {
        if (generation !== this.#generation) return
        this.#connection = state
        this.#error = error
        this.#setCheck('ws', state === 'connected' ? true : state === 'failed' ? false : null, state === 'failed' ? error : undefined)
        if (state === 'connected') this.#retries = 0
        if (state === 'failed') this.#retryLater(generation)
        this.#options.changed()
      })
      // Stuck at "connecting" (no ready, no error) is as good as failed.
      const watchdog = setTimeout(() => {
        if (generation !== this.#generation || this.#connection === 'connected') return
        this.#options.log.warn('feishu: the long connection did not open in time')
        this.#retryLater(generation)
      }, this.#options.connectTimeoutMs ?? 45_000)
      watchdog.unref?.()
    } catch (error) {
      this.#connection = 'failed'
      this.#error = message(error)
      this.#setCheck('ws', false, this.#error)
      this.#retryLater(generation)
    }
    this.#options.changed()
  }

  /**
   * Try again by itself, so a start that failed for a passing reason (no
   * network yet, a timeout) recovers without the user pressing 重新检查.
   * Wrong settings fail the same way each time and only cost a request per wait.
   */
  #retryLater(generation: number): void {
    if (generation !== this.#generation || this.#retryTimer !== undefined) return
    const delays = this.#options.retryDelaysMs ?? RETRY_DELAYS_MS
    if (delays.length === 0) return
    const delay = delays[Math.min(this.#retries, delays.length - 1)]!
    this.#retries++
    this.#options.log.info(`feishu: not connected, trying again in ${Math.round(delay / 1000)}s`)
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      if (generation === this.#generation) void this.restart().catch(error => this.#options.log.warn(`feishu reconnect failed: ${message(error)}`))
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

  async configure(patch: { enabled?: boolean | undefined; appId?: string | null | undefined; domain?: FeishuSettings['domain'] | undefined; chatId?: string | null | undefined; otherApprovals?: boolean | undefined }): Promise<void> {
    const next: FeishuSettings = { ...this.#state.settings }
    if (patch.enabled !== undefined) next.enabled = patch.enabled
    if (patch.domain !== undefined) next.domain = patch.domain
    if (patch.otherApprovals !== undefined) next.otherApprovals = patch.otherApprovals
    if (patch.appId !== undefined) { if (patch.appId === null || patch.appId === '') delete next.appId; else next.appId = patch.appId }
    if (patch.chatId !== undefined) { if (patch.chatId === null || patch.chatId === '') delete next.chatId; else next.chatId = patch.chatId }
    const reconnect = next.enabled !== this.#state.settings.enabled || next.appId !== this.#state.settings.appId || next.domain !== this.#state.settings.domain
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
    await this.#api?.sendText({ openId }, '你已被允许使用 AutoDailyGamePlay 机器人：脚本出问题时我会通知你，也可以直接让我干活，例如「现在什么状态」「跑一下方舟日常」。').catch(() => {})
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
    const detail = !settings.enabled ? '填写 App ID 和 App Secret，保存后启用'
      : settings.appId === undefined || !this.#secretConfigured ? '还没有填写 App ID 和 App Secret'
        : this.#error ?? this.#checks.find(c => c.ok === false)?.detail
    return { id: this.id, name: this.name, state, ...(detail === undefined ? {} : { detail }), recipients: this.#targets().length, checks: this.#checks }
  }

  /** Credentials, bot capability, long connection, recipients. */
  async check(): Promise<ChannelCheck[]> {
    const checks = this.#configChecks()
    const api = this.#api
    if (api !== undefined) {
      try {
        await api.token()
        put(checks, 'token', true, '凭证有效')
        try {
          const bot = await api.botInfo()
          put(checks, 'bot', true, bot.name === '' ? '机器人能力已开启' : `机器人「${bot.name}」`)
        } catch (error) {
          put(checks, 'bot', false, message(error))
        }
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
    return [
      { id: 'config', label: 'App ID 与 App Secret', ok: configured, ...(configured ? {} : { detail: settings.appId === undefined ? '填写 App ID' : '填写 App Secret' }) },
      { id: 'token', label: '凭证有效', ok: null },
      { id: 'bot', label: '机器人能力', ok: null },
      { id: 'ws', label: '长连接（接收消息和按钮）', ok: null },
      { id: 'users', label: '已允许的用户', ok: this.#targets().length > 0, ...(this.#targets().length > 0 ? {} : { detail: '给机器人发一条消息，然后在下面「待允许」里允许自己' }) },
    ]
  }

  #setCheck(id: string, ok: boolean | null, detail?: string): void {
    put(this.#checks, id, ok, detail)
  }

  // ── out ───────────────────────────────────────────────────────────────

  async send(notice: Notice): Promise<void> {
    const api = this.#ready()
    const targets = this.#targets()
    if (targets.length === 0) throw new Error('还没有允许任何飞书用户')
    let imageKey: string | undefined
    if (notice.image !== undefined) imageKey = await api.uploadImage(notice.image).catch(error => { this.#options.log.warn(`image upload failed: ${message(error)}`); return undefined })
    const card = noticeCard(notice, { imageKey })
    const delivered: Delivered = { notice, messageIds: [], ...(imageKey === undefined ? {} : { imageKey }) }
    const errors: string[] = []
    for (const target of targets) {
      try {
        const id = await api.sendCard(target, card)
        delivered.messageIds.push(id)
        this.#byMessage.set(id, notice.id)
      } catch (error) {
        errors.push(message(error))
      }
    }
    if (delivered.messageIds.length === 0) throw new Error(errors[0] ?? '没有发出去')
    this.#delivered.set(notice.id, delivered)
    while (this.#delivered.size > KEEP_DELIVERED) {
      const oldest = this.#delivered.keys().next().value!
      for (const id of this.#delivered.get(oldest)!.messageIds) this.#byMessage.delete(id)
      this.#delivered.delete(oldest)
    }
  }

  async sendTo(openId: string, notice: Notice): Promise<void> {
    const api = this.#ready()
    if (!this.#allowed(openId)) throw new Error('这个飞书用户没有被允许')
    // Sent on request (a screenshot the person asked for): without the picture there is nothing to send.
    const imageKey = notice.image === undefined ? undefined : await api.uploadImage(notice.image)
    const messageId = await api.sendCard({ openId }, noticeCard(notice, { imageKey }))
    this.#byMessage.set(messageId, notice.id)
  }

  async update(id: string, patch: NoticePatch): Promise<void> {
    const delivered = this.#delivered.get(id)
    const api = this.#api
    if (delivered === undefined || api === undefined) return
    const card = noticeCard(delivered.notice, { imageKey: delivered.imageKey, done: patch.done, text: patch.text })
    for (const messageId of delivered.messageIds) await api.patchCard(messageId, card).catch(error => this.#options.log.warn(`card patch failed: ${message(error)}`))
  }

  /**
   * A Feishu conversation's approvals go to its person only; other sessions'
   * (the UI, schedules) to everyone, and only when 「其他会话」 is on.
   */
  readonly approvals = {
    active: (owner: string | undefined) => {
      const { settings } = this.#state
      if (!settings.enabled || this.#connection !== 'connected') return false
      return owner !== undefined ? this.#allowed(owner) : settings.otherApprovals && this.#targets().length > 0
    },
    ask: async (request: ApprovalRequested, owner: string | undefined) => {
      const api = this.#ready()
      const own = owner !== undefined
      const card = approvalCard(request, { own })
      const messageIds: string[] = []
      for (const target of own ? [{ openId: owner }] : this.#targets()) messageIds.push(await api.sendCard(target, card))
      this.#approvals.set(request.approvalId, { request, own, messageIds })
    },
    resolved: async (approvalId: string, outcome: string) => {
      const entry = this.#approvals.get(approvalId)
      if (entry === undefined || this.#api === undefined) return
      this.#approvals.delete(approvalId)
      const card = approvalCard(entry.request, { own: entry.own, outcome: OUTCOME[outcome] ?? outcome })
      for (const messageId of entry.messageIds) await this.#api.patchCard(messageId, card).catch(() => {})
    },
  }

  #targets(): Target[] {
    const { settings } = this.#state
    return [...settings.allowedUsers.map(u => ({ openId: u.openId })), ...(settings.chatId === undefined ? [] : [{ chatId: settings.chatId }])]
  }

  #ready(): FeishuApi {
    if (this.#api === undefined || this.#connection !== 'connected') throw new Error(this.status().detail ?? '飞书还没有连接')
    return this.#api
  }

  #actor(openId: string, name?: string): Actor {
    const shown = this.#state.settings.allowedUsers.find(u => u.openId === openId)?.name ?? name
    return { channel: 'feishu', userId: openId, ...(shown === undefined ? {} : { name: shown }) }
  }

  #allowed(openId: string): boolean {
    return this.#state.settings.allowedUsers.some(u => u.openId === openId)
  }

  // ── in ────────────────────────────────────────────────────────────────

  #onMessage(event: InboundMessage): void {
    if (event.chatType !== 'p2p' && !event.mentionsBot) return
    const api = this.#api
    if (api === undefined) return
    if (!this.#allowed(event.senderOpenId)) {
      void this.#rememberStranger(event)
      void api.replyText(event.messageId, `你还没有被允许使用这个机器人。\n你的 open_id：${event.senderOpenId}\n请在 AutoDailyGamePlay 的「设置 → 飞书」里允许你自己。`).catch(() => {})
      return
    }
    if (event.messageType !== 'text' && event.messageType !== 'post') {
      void api.replyText(event.messageId, '目前只看得懂文字消息。').catch(() => {})
      return
    }
    if (event.text === '') return
    // One person's messages are handled in order; different people in parallel.
    const key = event.senderOpenId
    const previous = this.#queues.get(key) ?? Promise.resolve()
    const next = previous.then(() => this.#answer(api, event)).catch(error => this.#options.log.warn(`reply failed: ${message(error)}`))
    this.#queues.set(key, next)
    void next.then(() => { if (this.#queues.get(key) === next) this.#queues.delete(key) })
  }

  async #answer(api: FeishuApi, event: InboundMessage): Promise<void> {
    const notify = this.#options.notify()
    if (notify === undefined) {
      await api.replyText(event.messageId, '消息服务没有加载。')
      return
    }
    let answered = false
    const ack = setTimeout(() => { if (!answered) void api.replyText(event.messageId, '收到，正在处理…').catch(() => {}) }, this.#options.ackAfterMs ?? 4000)
    try {
      const replyTo = event.parentId === undefined ? undefined : this.#byMessage.get(event.parentId)
      const reply = await notify.inbound({ actor: this.#actor(event.senderOpenId), text: event.text, replyTo })
      answered = true
      await api.replyText(event.messageId, reply)
    } catch (error) {
      answered = true
      await api.replyText(event.messageId, `出错了：${message(error)}`).catch(() => {})
    } finally {
      clearTimeout(ack)
    }
  }

  async #rememberStranger(event: InboundMessage): Promise<void> {
    const pending = [{ openId: event.senderOpenId, at: Date.now(), text: event.text.slice(0, 100) }, ...this.#state.pending.filter(p => p.openId !== event.senderOpenId)].slice(0, KEEP_PENDING)
    this.#state = { ...this.#state, pending }
    await this.#options.save(this.#state).catch(() => {})
    this.#options.changed()
  }

  async #onCardAction(event: CardAction): Promise<CardActionResponse | undefined> {
    if (!this.#allowed(event.operatorOpenId)) return { toast: { type: 'error', content: '你没有被允许操作这个机器人' } }
    const notify = this.#options.notify()
    if (notify === undefined) return { toast: { type: 'error', content: '消息服务没有加载' } }
    const actor = this.#actor(event.operatorOpenId, event.operatorName)
    const { kind, id } = event.value
    if (kind === 'approval' && typeof id === 'string') {
      const decision = event.value['decision'] === 'allow-once' ? 'allow-once' : 'reject'
      const entry = this.#approvals.get(id)
      const answered = notify.respondApproval(id, decision, actor)
      if (!answered) return { toast: { type: 'info', content: '这个请求已经在别处回答过了' } }
      const outcome = `${decision === 'allow-once' ? '已允许这一次' : '已拒绝'}（${actor.name ?? actor.userId}）`
      return { toast: { type: 'success', content: outcome }, ...(entry === undefined ? {} : { card: approvalCard(entry.request, { own: entry.own, outcome }) }) }
    }
    if (kind === 'notice' && typeof id === 'string' && typeof event.value['action'] === 'string') {
      const work = notify.act(id, event.value['action'], actor)
      const budget = new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), this.#options.clickBudgetMs ?? 2500))
      try {
        const result = await Promise.race([work, budget])
        if (result === 'pending') {
          void work.catch(error => this.#options.log.warn(`notice action failed: ${message(error)}`))
          return { toast: { type: 'info', content: '已收到，正在处理' } }
        }
        return { toast: { type: 'success', content: result } }
      } catch (error) {
        return { toast: { type: 'error', content: message(error).slice(0, 100) } }
      }
    }
    return { toast: { type: 'warning', content: '不认识这个按钮' } }
  }
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
