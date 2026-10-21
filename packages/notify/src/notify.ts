/**
 * The chat layer, independent of any one chat app (docs/PLAN.zh.md §5.6):
 *
 * - Notices: plugins (the monitor) `send` a notice with buttons; channels
 *   render it (a Feishu card) and report clicks back through `act`, which
 *   routes to the handler the sender registered for its scope.
 * - Replies: a person's message that is just a button label ("停止") acts on
 *   the notice it replies to, or on the only open notice offering it.
 * - Conversation: anything else goes to the agent in a dsh session kept per
 *   person, and the agent's final answer is the reply.
 * - Approvals: a chat conversation's questions go to its person only, on its
 *   channel; other sessions' questions go to channels that take them (Feishu's
 *   「其他会话」 setting). The first answer anywhere (UI or chat) wins.
 *
 * Channels (Feishu now; QQ / WeCom / Telegram later) only translate.
 */
import { randomUUID } from 'node:crypto'
import type { ApprovalRequested, ChannelStatus } from '@adg/protocol'

export interface NoticeAction {
  readonly id: string
  readonly label: string
  readonly style?: 'primary' | 'danger' | 'default'
}

export interface Notice {
  /** Stable id (e.g. the incident id); later updates refer to it. */
  readonly id: string
  /** Which handler gets the button clicks (see `onAction`). */
  readonly scope: string
  readonly title: string
  /** Plain text; line breaks kept. */
  readonly text: string
  readonly severity: 'info' | 'success' | 'warning' | 'error'
  /** PNG shown with the notice. */
  readonly image?: Buffer
  readonly actions?: readonly NoticeAction[]
}

export interface NoticePatch {
  readonly text?: string
  /** Final note; the buttons go away. */
  readonly done?: string
}

/** Who did something in a channel. */
export interface Actor {
  readonly channel: string
  readonly userId: string
  readonly name?: string
}

/** @returns a short result for people, e.g. "已停止". */
export type ActionHandler = (noticeId: string, actionId: string, actor: Actor) => Promise<string>

export interface Channel {
  readonly id: string
  readonly name: string
  status(): ChannelStatus
  /** Deliver to the channel's recipients. @throws Error when it could not. */
  send(notice: Notice): Promise<void>
  update?(id: string, patch: NoticePatch): Promise<void>
  /** Deliver to one person only (a reply to something they asked for). */
  sendTo?(userId: string, notice: Notice): Promise<void>
  /**
   * Approval cards, when the channel and its settings allow them. `owner`: the
   * person on this channel whose conversation asks (send to them only);
   * undefined for a session started anywhere else.
   */
  readonly approvals?: {
    active(owner: string | undefined): boolean
    ask(request: ApprovalRequested, owner: string | undefined): Promise<void>
    resolved(approvalId: string, outcome: string): Promise<void>
  }
}

/** The slice of dsh's session controller a conversation needs. */
export interface Conversations {
  /** Send `text` (and PNG images) as a message in `sessionId` and resolve with the agent's final answer. */
  ask(sessionId: string, text: string, signal: AbortSignal, images?: readonly Buffer[]): Promise<string>
  /** A new session; `defaultModel`: use the default model (else the one last used in the UI). */
  create(title: string, options?: { defaultModel?: boolean }): Promise<string>
  exists(sessionId: string): Promise<boolean>
}

export interface NotifyOptions {
  readonly conversations: () => Conversations | undefined
  readonly respondApproval: (approvalId: string, decision: 'allow-once' | 'reject') => boolean
  /** Person → dsh session, persisted by the caller. */
  readonly sessions: { get(key: string): string | undefined; set(key: string, sessionId: string): Promise<void>; keyOf?(sessionId: string): string | undefined }
  readonly changed: () => void
  readonly log: { info(message: string): void; warn(message: string): void }
  readonly now?: () => number
}

interface Sent {
  readonly notice: Notice
  readonly at: number
  open: boolean
}

const KEEP_NOTICES = 200
const REPLY_WINDOW_MS = 24 * 3_600_000

export class Notify {
  readonly #options: NotifyOptions
  readonly #channels = new Map<string, Channel>()
  readonly #handlers = new Map<string, ActionHandler>()
  readonly #sent = new Map<string, Sent>()
  readonly #now: () => number

  constructor(options: NotifyOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  // ── channels ──────────────────────────────────────────────────────────

  /** @returns a disposer. */
  registerChannel(channel: Channel): () => void {
    this.#channels.set(channel.id, channel)
    this.#options.changed()
    return () => {
      if (this.#channels.get(channel.id) === channel) this.#channels.delete(channel.id)
      this.#options.changed()
    }
  }

  channels(): ChannelStatus[] {
    return [...this.#channels.values()].map(c => c.status())
  }

  /** Questions from `sessionId` can go somewhere right now. */
  approvalsActive(sessionId: string): boolean {
    return this.#approvalRoutes(sessionId).length > 0
  }

  // ── notices ───────────────────────────────────────────────────────────

  /** @returns a disposer. */
  onAction(scope: string, handler: ActionHandler): () => void {
    this.#handlers.set(scope, handler)
    return () => { if (this.#handlers.get(scope) === handler) this.#handlers.delete(scope) }
  }

  /**
   * Deliver to every ready channel.
   * @returns names of the channels it reached (empty: no channel is set up).
   */
  async send(notice: Notice): Promise<string[]> {
    this.#sent.set(notice.id, { notice, at: this.#now(), open: (notice.actions?.length ?? 0) > 0 })
    while (this.#sent.size > KEEP_NOTICES) this.#sent.delete(this.#sent.keys().next().value!)
    const reached: string[] = []
    const errors: string[] = []
    for (const channel of this.#channels.values()) {
      if (channel.status().state !== 'ready') continue
      try {
        await channel.send(notice)
        reached.push(channel.name)
      } catch (error) {
        errors.push(`${channel.name}：${message(error)}`)
        this.#options.log.warn(`notice ${notice.id} via ${channel.id} failed: ${message(error)}`)
      }
    }
    if (reached.length === 0 && errors.length > 0) throw new Error(errors.join('；'))
    return reached
  }

  async update(id: string, patch: NoticePatch): Promise<void> {
    const sent = this.#sent.get(id)
    if (sent === undefined) return
    if (patch.done !== undefined) sent.open = false
    for (const channel of this.#channels.values()) {
      if (channel.status().state !== 'ready' || channel.update === undefined) continue
      await channel.update(id, patch).catch(error => this.#options.log.warn(`updating ${id} via ${channel.id} failed: ${message(error)}`))
    }
  }

  /** A button click (or a reply naming one). @throws Error when the notice or its handler is gone. */
  async act(noticeId: string, actionId: string, actor: Actor): Promise<string> {
    const sent = this.#sent.get(noticeId)
    const scope = sent?.notice.scope ?? noticeId.split(':')[0]!
    const handler = this.#handlers.get(scope)
    if (handler === undefined) throw new Error('这条消息对应的功能没有加载')
    this.#options.log.info(`${actor.channel}:${actor.userId} → ${actionId} on ${noticeId}`)
    return handler(noticeId, actionId, actor)
  }

  // ── what people write ─────────────────────────────────────────────────

  /**
   * A message from an allowed person. Button labels act on notices;
   * anything else is a conversation with the agent.
   * @returns the reply to send back.
   */
  async inbound(message_: { actor: Actor; text: string; replyTo?: string | undefined; signal?: AbortSignal }): Promise<string> {
    const text = message_.text.trim()
    const target = this.#noticeFor(text, message_.replyTo)
    if (target !== undefined) {
      try {
        return await this.act(target.notice.id, target.action, message_.actor)
      } catch (error) {
        return `没能完成：${message(error)}`
      }
    }
    const conversations = this.#options.conversations()
    if (conversations === undefined) return 'agent 现在不可用（会话服务没有加载）。'
    const key = `${message_.actor.channel}:${message_.actor.userId}`
    let sessionId = this.#options.sessions.get(key)
    if (sessionId === undefined || !(await conversations.exists(sessionId))) {
      sessionId = await conversations.create(`${message_.actor.channel === 'feishu' ? '飞书' : message_.actor.channel}：${message_.actor.name ?? message_.actor.userId}`)
      await this.#options.sessions.set(key, sessionId)
    }
    return conversations.ask(sessionId, text, message_.signal ?? AbortSignal.timeout(20 * 60_000))
  }

  /** The notice a short reply like "停止" means, if it means one. */
  #noticeFor(text: string, replyTo: string | undefined): { notice: Notice; action: string } | undefined {
    const label = text.replace(/[。.!！\s]/g, '')
    if (label.length === 0 || label.length > 6) return undefined
    const matches = (sent: Sent) => sent.notice.actions?.find(a => a.label === label)
    if (replyTo !== undefined) {
      const sent = this.#sent.get(replyTo)
      const action = sent === undefined ? undefined : matches(sent)
      return sent !== undefined && action !== undefined ? { notice: sent.notice, action: action.id } : undefined
    }
    const now = this.#now()
    const open = [...this.#sent.values()].filter(s => s.open && now - s.at < REPLY_WINDOW_MS && matches(s) !== undefined)
    if (open.length !== 1) return undefined
    return { notice: open[0]!.notice, action: matches(open[0]!)!.id }
  }

  /**
   * Send to the person whose conversation `sessionId` is (e.g. the screenshot
   * they asked for in Feishu). @returns false when the session is not a chat-channel conversation.
   */
  async sendToSession(sessionId: string, notice: Notice): Promise<boolean> {
    const key = this.#options.sessions.keyOf?.(sessionId)
    if (key === undefined) return false
    const [channelId, ...rest] = key.split(':')
    const channel = this.#channels.get(channelId!)
    if (channel?.sendTo === undefined || channel.status().state !== 'ready') return false
    await channel.sendTo(rest.join(':'), notice)
    return true
  }

  // ── approvals ─────────────────────────────────────────────────────────

  askApproval(request: ApprovalRequested): void {
    for (const { channel, owner } of this.#approvalRoutes(request.sessionId)) {
      void channel.approvals!.ask(request, owner).catch(error => this.#options.log.warn(`approval card via ${channel.id} failed: ${message(error)}`))
    }
  }

  /**
   * Where a question from `sessionId` may go: a chat conversation's only to its
   * person (not the group, other people or other channels); any other
   * session's to the channels that take those.
   */
  #approvalRoutes(sessionId: string): { channel: Channel; owner: string | undefined }[] {
    const key = this.#options.sessions.keyOf?.(sessionId)
    if (key !== undefined) {
      const [channelId, ...rest] = key.split(':')
      const channel = this.#channels.get(channelId!)
      const owner = rest.join(':')
      return channel?.approvals?.active(owner) === true ? [{ channel, owner }] : []
    }
    return [...this.#channels.values()].filter(c => c.approvals?.active(undefined) === true).map(channel => ({ channel, owner: undefined }))
  }

  approvalResolved(approvalId: string, outcome: string): void {
    for (const channel of this.#channels.values()) void channel.approvals?.resolved(approvalId, outcome).catch(() => {})
  }

  /** A person answered an approval card. @returns false when someone else answered first. */
  respondApproval(approvalId: string, decision: 'allow-once' | 'reject', actor: Actor): boolean {
    const answered = this.#options.respondApproval(approvalId, decision)
    if (answered) this.#options.log.info(`${actor.channel}:${actor.userId} ${decision} approval ${approvalId}`)
    return answered
  }

  // ── test ──────────────────────────────────────────────────────────────

  async test(channelId?: string): Promise<{ sent: string[]; failed: { channel: string; error: string }[] }> {
    const notice: Notice = {
      id: `test:${randomUUID()}`, scope: 'test', severity: 'info', title: 'AutoDailyGamePlay 测试消息',
      text: `消息渠道工作正常。脚本出错时会这样通知你，也可以直接回复消息让 agent 干活，例如「现在什么状态」。\n${new Date(this.#now()).toLocaleString('zh-CN')}`,
    }
    const sent: string[] = []
    const failed: { channel: string; error: string }[] = []
    for (const channel of this.#channels.values()) {
      if (channelId !== undefined && channel.id !== channelId) continue
      if (channel.status().state !== 'ready') {
        failed.push({ channel: channel.name, error: channel.status().detail ?? '还没有连接' })
        continue
      }
      try {
        await channel.send(notice)
        sent.push(channel.name)
      } catch (error) {
        failed.push({ channel: channel.name, error: message(error) })
      }
    }
    return { sent, failed }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
