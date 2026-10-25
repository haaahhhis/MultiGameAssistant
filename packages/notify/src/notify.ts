/**
 * The chat layer, independent of any one chat app (docs/PLAN.zh.md §5.6):
 *
 * - Notices: plugins (the monitor) `send` a notice with buttons; channels
 *   render it (a Feishu card) and report clicks back through `act`, which
 *   routes to the handler the sender registered for its scope.
 * - Replies: a person's message that is just a button label ("停止") acts on
 *   the notice it replies to, or on the only open notice offering it.
 * - Conversation: anything else goes to the agent in a dsh session kept per
 *   person; the reply is the whole turn, channel-neutral (reply.ts): what the
 *   agent said and the steps between, as the app shows it. A session whose
 *   folder is gone (renamed, moved) is replaced, its last messages carried over.
 * - Approvals and the agent's questions (ask_user_question): a chat
 *   conversation's go to its person only, on its channel; other sessions' go
 *   to channels that take them (Feishu's 「软件里的会话」 setting). A reply
 *   while the agent waits for that person answers the question. The first
 *   answer anywhere (UI or chat) wins.
 *
 * Channels (Feishu now; QQ / WeCom / Telegram later) only translate.
 */
import { randomUUID } from 'node:crypto'
import type { ApprovalRequested, ChannelStatus, QuestionAnswerItem, QuestionItem, QuestionRequested } from '@adg/protocol'
import { textReply, type Reply } from './reply.ts'

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
  /**
   * The agent's questions (ask_user_question) as cards, routed like approvals.
   * Answers come back through `answerQuestion`, or as a plain reply (`inbound`).
   */
  readonly questions?: {
    active(owner: string | undefined): boolean
    ask(request: QuestionRequested, owner: string | undefined): Promise<void>
    /** Answered (with what) or withdrawn anywhere. */
    resolved(questionId: string, outcome: string, answers: readonly QuestionAnswerItem[] | undefined): Promise<void>
  }
}

/** Where a question stands: what each item was answered with so far. */
export interface QuestionProgress {
  readonly done: boolean
  /** The next unanswered question, when not done. */
  readonly next?: QuestionItem
}

/** The slice of dsh's session controller a conversation needs. */
export interface Conversations {
  /** Send `text` (and PNG images) as a message in `sessionId` and resolve with the agent's final answer. */
  ask(sessionId: string, text: string, signal: AbortSignal, images?: readonly Buffer[]): Promise<string>
  /** The same, resolving with the whole turn (what the agent said and did). Absent: the final answer only. */
  converse?(sessionId: string, text: string, signal: AbortSignal, images?: readonly Buffer[]): Promise<Reply>
  /** A new session; `defaultModel`: use the default model (else the one last used in the UI). */
  create(title: string, options?: { defaultModel?: boolean }): Promise<string>
  /** False also when the session cannot work any more (its folder is gone). */
  exists(sessionId: string): Promise<boolean>
  /** The session's last few messages as text, to carry into a new one. */
  recent?(sessionId: string): Promise<string | undefined>
}

export interface NotifyOptions {
  readonly conversations: () => Conversations | undefined
  readonly respondApproval: (approvalId: string, decision: 'allow-once' | 'reject') => boolean
  /** Answer the agent's question at the gateway. @returns false when it is gone or answered. */
  readonly respondQuestion?: (questionId: string, answers: readonly QuestionAnswerItem[]) => boolean
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
  /** Open questions: whose conversation asked (`channel:user`, if one did) and the answers so far. */
  readonly #questions = new Map<string, { request: QuestionRequested; key: string | undefined; answers: Map<string, QuestionAnswerItem> }>()
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

  /** Approvals from `sessionId` can go somewhere right now. */
  approvalsActive(sessionId: string): boolean {
    return this.#routes(sessionId, 'approvals').length > 0
  }

  /** The agent's questions from `sessionId` can go somewhere right now. */
  questionsActive(sessionId: string): boolean {
    return this.#routes(sessionId, 'questions').length > 0
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
   * @returns the reply to send back, for the channel to render.
   */
  async inbound(message_: { actor: Actor; text: string; replyTo?: string | undefined; signal?: AbortSignal }): Promise<Reply> {
    const text = message_.text.trim()
    // The agent is waiting for this person's answer: the message is it.
    const key = `${message_.actor.channel}:${message_.actor.userId}`
    const waiting = [...this.#questions.entries()].find(([, q]) => q.key === key)
    if (waiting !== undefined && text !== '') return textReply(await this.#replyToQuestion(waiting[0], text, message_.actor))
    const target = this.#noticeFor(text, message_.replyTo)
    if (target !== undefined) {
      try {
        return textReply(await this.act(target.notice.id, target.action, message_.actor))
      } catch (error) {
        return textReply(`没能完成：${message(error)}`)
      }
    }
    const conversations = this.#options.conversations()
    if (conversations === undefined) return textReply('agent 现在不可用（会话服务没有加载）。')
    let sessionId = this.#options.sessions.get(key)
    let prompt = text
    let note: string | undefined
    if (sessionId === undefined || !(await conversations.exists(sessionId))) {
      // The old one can no longer work (deleted, or its folder renamed): start again with its last messages.
      const earlier = sessionId === undefined ? undefined : await conversations.recent?.(sessionId).catch(() => undefined)
      sessionId = await conversations.create(`${message_.actor.channel === 'feishu' ? '飞书' : message_.actor.channel}：${message_.actor.name ?? message_.actor.userId}`)
      await this.#options.sessions.set(key, sessionId)
      if (earlier !== undefined) {
        prompt = `（之前的对话没法继续了，换成了这个新对话。下面是之前最后几条消息，供参考：）\n${earlier}\n\n（现在的消息：）\n${text}`
        note = '（之前的对话没法继续了：被删掉了，或者它所在的文件夹改了名、挪了地方。已经换成新对话，带上了最近几条消息。）'
      }
    }
    const signal = message_.signal ?? AbortSignal.timeout(20 * 60_000)
    const reply = conversations.converse !== undefined ? await conversations.converse(sessionId, prompt, signal) : textReply(await conversations.ask(sessionId, prompt, signal))
    return note === undefined ? reply : { blocks: [{ kind: 'text', text: note }, ...reply.blocks] }
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
    for (const { channel, owner } of this.#routes(request.sessionId, 'approvals')) {
      void channel.approvals!.ask(request, owner).catch(error => this.#options.log.warn(`approval card via ${channel.id} failed: ${message(error)}`))
    }
  }

  /**
   * Where an approval or question from `sessionId` may go: a chat
   * conversation's only to its person (not the group, other people or other
   * channels); any other session's to the channels that take those.
   */
  #routes(sessionId: string, kind: 'approvals' | 'questions'): { channel: Channel; owner: string | undefined }[] {
    const key = this.#options.sessions.keyOf?.(sessionId)
    if (key !== undefined) {
      const [channelId, ...rest] = key.split(':')
      const channel = this.#channels.get(channelId!)
      const owner = rest.join(':')
      return channel?.[kind]?.active(owner) === true ? [{ channel, owner }] : []
    }
    return [...this.#channels.values()].filter(c => c[kind]?.active(undefined) === true).map(channel => ({ channel, owner: undefined }))
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

  // ── the agent's questions ─────────────────────────────────────────────

  askQuestion(request: QuestionRequested): void {
    const routes = this.#routes(request.sessionId, 'questions')
    if (routes.length === 0) return
    const key = this.#options.sessions.keyOf?.(request.sessionId)
    this.#questions.set(request.questionId, { request, key, answers: new Map() })
    for (const { channel, owner } of routes) {
      void channel.questions!.ask(request, owner).catch(error => this.#options.log.warn(`question card via ${channel.id} failed: ${message(error)}`))
    }
  }

  questionResolved(questionId: string, outcome: string, answers?: readonly QuestionAnswerItem[]): void {
    this.#questions.delete(questionId)
    for (const channel of this.#channels.values()) void channel.questions?.resolved(questionId, outcome, answers).catch(() => {})
  }

  /**
   * One question of a request answered (a card button, or a reply). Once every
   * question has an answer, the whole batch goes to the agent.
   * @returns where it stands, or undefined when the question is gone (answered elsewhere, withdrawn).
   */
  answerQuestion(questionId: string, item: QuestionAnswerItem, actor: Actor): QuestionProgress | undefined {
    const open = this.#questions.get(questionId)
    if (open === undefined || !open.request.questions.some(q => q.id === item.id)) return undefined
    open.answers.set(item.id, item)
    const next = open.request.questions.find(q => !open.answers.has(q.id))
    if (next !== undefined) return { done: false, next }
    const answered = this.#options.respondQuestion?.(questionId, open.request.questions.map(q => open.answers.get(q.id)!)) ?? false
    if (!answered) return undefined
    this.#options.log.info(`${actor.channel}:${actor.userId} answered question ${questionId}`)
    return { done: true }
  }

  /** A reply while the agent waits for this person: an option's label or number picks it, anything else is the answer itself. */
  #replyToQuestion(questionId: string, text: string, actor: Actor): string {
    const open = this.#questions.get(questionId)!
    const item = open.request.questions.find(q => !open.answers.has(q.id)) ?? open.request.questions[0]!
    const options = item.options ?? []
    const plain = text.replace(/[。.!！\s]/g, '')
    const byNumber = /^\d+$/.test(plain) ? options[Number(plain) - 1] : undefined
    const byLabel = options.find(o => o.label.replace(/[。.!！\s]/g, '') === plain || o.label.replace(/\s*[(（]推荐[)）]|\s*\(Recommended\)/i, '').replace(/[。.!！\s]/g, '') === plain)
    const chosen = byNumber ?? byLabel
    const progress = this.answerQuestion(questionId, chosen !== undefined ? { id: item.id, selected: [chosen.label] } : { id: item.id, selected: [], custom: text }, actor)
    if (progress === undefined) return '这个问题已经在别处回答过了。'
    if (!progress.done) return `收到。还有一个问题：${describeQuestion(progress.next!)}`
    return `收到，已经告诉 agent：${chosen?.label ?? text}`
  }

  // ── test ──────────────────────────────────────────────────────────────

  async test(channelId?: string): Promise<{ sent: string[]; failed: { channel: string; error: string }[] }> {
    const notice: Notice = {
      id: `test:${randomUUID()}`, scope: 'test', severity: 'info', title: 'MultiGameAssistant 测试消息',
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

/** A question as chat text: the question, then its choices numbered (reply with the number or the words). */
export function describeQuestion(item: QuestionItem): string {
  const options = item.options ?? []
  return [item.question, ...options.map((o, i) => `${i + 1}. ${o.label}${o.description === undefined ? '' : `（${o.description}）`}`)].join('\n')
}
