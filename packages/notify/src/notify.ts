/**
 * The chat layer, independent of any one chat app:
 *
 * - Notices: plugins (the monitor) `send` a notice with buttons; channels
 *   render it (a Feishu card) and report clicks back through `act`, which
 *   routes to the handler the sender registered for its scope.
 * - Replies: a person's message that is just a button label ("停止") acts on
 *   the notice it replies to, or on the only open notice offering it.
 * - Conversation: anything else goes to 助手, in its one conversation — the
 *   same one the app shows (docs/design/agent-roles.md §10); the reply is the
 *   whole turn, channel-neutral (reply.ts): what the agent said and the steps
 *   between, as the app shows it.
 * - Mirror: everything else in that conversation — what was typed in the app
 *   or written from another chat app, work handed to 助手, 助手's messages
 *   with the other agents, its replies — goes to every chat person as text
 *   (mirror.ts), so the app and the chat apps show the same conversation.
 * - Notices are part of that conversation too: kept (`notices`), shown in
 *   助手's conversation in the app with their buttons, and told to 助手 when
 *   its next turn starts (`untold`, index.ts), so a reply in words (「改吧」)
 *   reaches an agent that knows what it answers — it acts with notice_act.
 *   An action picked anywhere is told to the other places.
 * - Approvals and the agent's questions (ask_user_question): a chat
 *   conversation's go to its person only, on its channel; other sessions'
 *   go to channels that take them (Feishu's 「软件里的会话」 setting). A reply
 *   while the agent waits for that person answers the question, or the
 *   approval (「同意」「拒绝」); channels let it past the person's other
 *   messages (`waiting`), since the one before it waits for it. The first
 *   answer anywhere (UI or chat) wins.
 *
 * Channels (Feishu, QQ; WeCom / Telegram later) only translate.
 */
import { randomUUID } from 'node:crypto'
import { type ApprovalRequested, type ChannelStatus, type ChatNotice, type QuestionAnswerItem, type QuestionItem, type QuestionRequested } from '@adg/protocol'
import { MAIN } from './handoff.ts'
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

/** A message of 助手's conversation for a chat app: plain text, or markdown where the channel renders it. */
export interface MirrorPost {
  readonly text: string
  readonly markdown?: boolean
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
  /** 助手's conversation as it goes, to every person this channel talks to but `except` (whose own message or answer it is). */
  mirror?(post: MirrorPost, except: string | undefined): Promise<void>
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
  /**
   * The agent's one conversation (the gateway's `home`; `main`: 助手's), made when it has none;
   * `focus`: what its next work is about, whose skills it sees (the gateway's skill scope).
   */
  home(agent: string, options?: { focus?: { scripts?: string[]; games?: string[] } }): Promise<string>
  /**
   * Hand work to an agent (docs/design/agent-roles.md §10): a message in its conversation saying who
   * asked, then the work; resolves with that turn (a turn that ended early resolves too). Kept as a
   * hand-off (the gateway's `handOffs`). With `relay`, its reply — or why it did not finish — then goes
   * back to the conversation that asked (`from`, by default 助手's) as a message, without waiting.
   * @throws what the turn threw (called off, timed out), after recording it.
   */
  handOff(input: HandOffInput): Promise<Reply>
  /**
   * A one-off session; `defaultModel`: use the default model (else the one last used in the UI);
   * `focus`: the scripts and games it is about; `role`: the role agent it belongs to, created with the
   * role agents' model when one is chosen (over `defaultModel`); absent: the main agent's. `by`: who asked.
   */
  create(title: string, options?: { defaultModel?: boolean; focus?: { scripts?: string[]; games?: string[] }; role?: string; by?: string }): Promise<string>
  /** When the session last changed (epoch ms). */
  lastActive?(sessionId: string): Promise<number | undefined>
}

export interface HandOffInput {
  /** The agent it goes to. */
  readonly to: { readonly id: string; readonly name: string }
  /** Who asks, in words: 助手, 监控. */
  readonly by: string
  /** A line saying what it is. */
  readonly title: string
  readonly task: string
  /** What a good answer looks like coming back. */
  readonly expecting?: string
  readonly focus?: { scripts?: string[]; games?: string[] }
  readonly images?: readonly Buffer[]
  readonly signal: AbortSignal
  /**
   * The conversation that asked, where the reply goes back; `callId`: its agent_delegate call;
   * `asker`: `by` as that conversation's agent knows itself (the reply then says 你).
   */
  readonly from?: { readonly sessionId: string; readonly callId?: string; readonly asker?: string }
  readonly relay?: boolean
  /** The asking agent's turn on the reply, once over (a chat channel forwards it). */
  readonly relayed?: (reply: Reply) => void
}

export interface NotifyOptions {
  readonly conversations: () => Conversations | undefined
  readonly respondApproval: (approvalId: string, decision: 'allow-once' | 'reject') => boolean
  /** Answer the agent's question at the gateway. @returns false when it is gone or answered. */
  readonly respondQuestion?: (questionId: string, answers: readonly QuestionAnswerItem[]) => boolean
  /**
   * Person → the conversation their messages go to (助手's), persisted by the caller: approvals and questions from it go to
   * them. Everyone's is 助手's one conversation, so `keyOf` gives the one who wrote last (`set` again on each message).
   */
  readonly sessions: { get(key: string): string | undefined; set(key: string, sessionId: string): Promise<void>; keyOf?(sessionId: string): string | undefined }
  readonly changed: () => void
  readonly log: { info(message: string): void; warn(message: string): void }
  /** Where the notices are kept between starts. Absent: in memory only. */
  readonly history?: { load(): Promise<readonly KeptNotice[]>; save(items: readonly KeptNotice[]): Promise<void> }
  /** A notice was sent, or what came of it changed. */
  readonly noticeChanged?: (item: ChatNotice) => void
  readonly now?: () => number
}

/** A notice as kept: `told`, 助手 has been told about it. */
export type KeptNotice = ChatNotice & { told?: boolean }

interface Sent {
  readonly notice: Notice
  readonly at: number
  open: boolean
}

const KEEP_NOTICES = 200
const KEEP_ORIGINS = 50
const KEEP_HISTORY = 100
const REPLY_WINDOW_MS = 24 * 3_600_000
/** At most this many notices are told to 助手 at once (the latest). */
const TELL_AT_MOST = 8
/**
 * A message after this long a silence says so: a long conversation is
 * compacted into a summary without dates, and the model then takes old open
 * questions for current ones.
 */
const IDLE_NOTE_MS = 12 * 3_600_000

export class Notify {
  readonly #options: NotifyOptions
  readonly #channels = new Map<string, Channel>()
  readonly #handlers = new Map<string, ActionHandler>()
  readonly #sent = new Map<string, Sent>()
  /** Open questions: whose conversation asked (`channel:user`, if one did) and the answers so far. */
  readonly #questions = new Map<string, { request: QuestionRequested; key: string | undefined; answers: Map<string, QuestionAnswerItem> }>()
  /** Open approvals asked of one person (their conversation's): approval id → `channel:user`. */
  readonly #approvals = new Map<string, string>()
  /** Who wrote to a conversation last from a chat app (`channel:user`): its approvals and questions go to them. */
  readonly #speakers = new Map<string, string>()
  /** Messages people sent from a chat app, as the agent got them, until the mirror has seen them: who wrote them. */
  readonly #origins = new Map<string, Actor>()
  /** The notices, oldest first (`notices`). */
  #history: KeptNotice[] = []
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

  /** Read the notices kept before this start. */
  async loadHistory(): Promise<void> {
    const kept = await this.#options.history?.load().catch(() => [] as KeptNotice[]) ?? []
    this.#history = [...kept, ...this.#history].slice(-KEEP_HISTORY)
  }

  /** The notices, oldest first. */
  notices(): ChatNotice[] {
    return this.#history.map(shown)
  }

  /** Notices of the last day 助手 has not been told about yet (the latest few), oldest first. */
  untold(): ChatNotice[] {
    const since = this.#now() - REPLY_WINDOW_MS
    return this.#history.filter(n => n.told !== true && n.at >= since).slice(-TELL_AT_MOST).map(shown)
  }

  /** 助手 has been told about these (and so no longer needs the older ones). */
  markTold(ids: readonly string[]): void {
    const last = Math.max(-1, ...ids.map(id => this.#history.findIndex(n => n.id === id)))
    if (last < 0) return
    this.#history = this.#history.map((n, i) => (i <= last && n.told !== true ? { ...n, told: true } : n))
    this.#saveHistory()
  }

  #changeNotice(id: string, change: (item: KeptNotice) => KeptNotice): void {
    const index = this.#history.findIndex(n => n.id === id)
    if (index < 0) return
    const item = change(this.#history[index]!)
    this.#history[index] = item
    this.#saveHistory()
    this.#options.noticeChanged?.(shown(item))
  }

  #saveHistory(): void {
    void this.#options.history?.save(this.#history).catch(error => this.#options.log.warn(`saving notices failed: ${message(error)}`))
  }

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
    const item: KeptNotice = {
      id: notice.id, title: notice.title, text: notice.text, severity: notice.severity, at: this.#now(),
      actions: (notice.actions ?? []).map(a => ({ id: a.id, label: a.label, ...(a.style === undefined ? {} : { style: a.style }) })),
      channels: reached,
      ...(notice.image === undefined ? {} : { image: true }),
    }
    this.#history = [...this.#history.filter(n => n.id !== notice.id), item].slice(-KEEP_HISTORY)
    this.#saveHistory()
    this.#options.noticeChanged?.(shown(item))
    if (reached.length === 0 && errors.length > 0) throw new Error(errors.join('；'))
    return reached
  }

  async update(id: string, patch: NoticePatch): Promise<void> {
    // The kept copy too, also for one sent before this start (the channels no longer know it).
    this.#changeNotice(id, item => ({ ...item, ...(patch.text === undefined ? {} : { text: patch.text }), ...(patch.done === undefined ? {} : { done: patch.done }) }))
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
    const result = await handler(noticeId, actionId, actor)
    // What came of it, where the others see it: the app's conversation, and the chat apps but the one who picked it.
    const kept = this.#history.find(n => n.id === noticeId)
    const label = (sent?.notice.actions ?? kept?.actions)?.find(a => a.id === actionId)?.label ?? actionId
    const by = this.#actorName(actor)
    if (sent !== undefined) sent.open = false
    this.#changeNotice(noticeId, item => ({ ...item, acted: { by, label, result, at: this.#now() } }))
    this.mirror({ text: `「${sent?.notice.title ?? kept?.title ?? noticeId}」：${by}选了「${label}」——${result}` }, actor.channel === 'app' || actor.channel === 'agent' ? undefined : actor)
    return result
  }

  /** Who picked an action, for people: 你（软件）, 你（QQ）, 助手. */
  #actorName(actor: Actor): string {
    if (actor.channel === 'agent') return actor.name ?? '助手'
    if (actor.channel === 'app') return '你（软件）'
    return `${actor.name ?? '你'}（${this.channelName(actor.channel)}）`
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
    const approval = [...this.#approvals.entries()].find(([, k]) => k === key)
    if (approval !== undefined && text !== '') return textReply(this.#replyToApproval(approval[0], text, message_.actor))
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
    let sessionId: string
    try {
      sessionId = await conversations.home(MAIN)
    } catch (error) {
      return textReply(`agent 现在不可用：${message(error)}`)
    }
    // Several people (Feishu, QQ) share 助手's conversation: what it asks next goes to the one talking now.
    if (this.#options.sessions.get(key) !== sessionId || this.#speakers.get(sessionId) !== key) await this.#options.sessions.set(key, sessionId)
    this.#speakers.set(sessionId, key)
    let prompt = text
    const lastActive = await conversations.lastActive?.(sessionId).catch(() => undefined)
    if (lastActive !== undefined && this.#now() - lastActive >= IDLE_NOTE_MS) {
      prompt = `（距离这个对话的上一条消息已经过了 ${Math.floor((this.#now() - lastActive) / 3_600_000)} 小时，之前说到的事可能早就变了：需要时先查现在的情况。）\n${text}`
    }
    const signal = message_.signal ?? AbortSignal.timeout(20 * 60_000)
    // Only the round's last message goes back (reply.ts): ask for it to be the summary.
    prompt = `${channelNote(message_.actor.channel)}\n${prompt}`
    this.#origins.set(prompt.trim(), message_.actor)
    while (this.#origins.size > KEEP_ORIGINS) this.#origins.delete(this.#origins.keys().next().value!)
    return conversations.converse !== undefined ? await conversations.converse(sessionId, prompt, signal) : textReply(await conversations.ask(sessionId, prompt, signal))
  }

  /** The agent waits for this person's answer (a question, an approval): their next message is it, not one to queue. */
  waiting(actor: Actor): boolean {
    const key = `${actor.channel}:${actor.userId}`
    return [...this.#questions.values()].some(q => q.key === key) || [...this.#approvals.values()].some(k => k === key)
  }

  /** The question the agent waits for this person to answer next, if any (a channel puts its choices under its reply). */
  nextQuestion(actor: Actor): QuestionItem | undefined {
    const key = `${actor.channel}:${actor.userId}`
    const open = [...this.#questions.values()].find(q => q.key === key)
    return open?.request.questions.find(q => !open.answers.has(q.id))
  }

  /** Who sent this message of 助手's conversation from a chat app (undefined: someone in the app); asked once. */
  originOf(text: string): Actor | undefined {
    const actor = this.#origins.get(text.trim())
    this.#origins.delete(text.trim())
    return actor
  }

  /** A channel's name for people (飞书, QQ). */
  channelName(channelId: string): string {
    return this.#channels.get(channelId)?.name ?? channelId
  }

  /** A message of 助手's conversation to every ready channel's people, but `except` (the person whose own message or answer it is). */
  mirror(post: MirrorPost, except?: Actor): void {
    for (const channel of this.#channels.values()) {
      if (channel.mirror === undefined || channel.status().state !== 'ready') continue
      void channel.mirror(post, except?.channel === channel.id ? except.userId : undefined)
        .catch(error => this.#options.log.warn(`mirroring via ${channel.id} failed: ${message(error)}`))
    }
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
    const key = this.#ownerKey(sessionId)
    if (key === undefined) return false
    const [channelId, ...rest] = key.split(':')
    const channel = this.#channels.get(channelId!)
    if (channel?.sendTo === undefined || channel.status().state !== 'ready') return false
    await channel.sendTo(rest.join(':'), notice)
    return true
  }

  // ── approvals ─────────────────────────────────────────────────────────

  askApproval(request: ApprovalRequested): void {
    const routes = this.#routes(request.sessionId, 'approvals')
    const key = this.#ownerKey(request.sessionId)
    if (key !== undefined && routes.length > 0) this.#approvals.set(request.approvalId, key)
    for (const { channel, owner } of routes) {
      void channel.approvals!.ask(request, owner).catch(error => this.#options.log.warn(`approval card via ${channel.id} failed: ${message(error)}`))
    }
  }

  /**
   * Where an approval or question from `sessionId` may go: a chat
   * conversation's only to its person (not the group, other people or other
   * channels); any other session's to the channels that take those.
   */
  #routes(sessionId: string, kind: 'approvals' | 'questions'): { channel: Channel; owner: string | undefined }[] {
    const key = this.#ownerKey(sessionId)
    if (key !== undefined) {
      const [channelId, ...rest] = key.split(':')
      const channel = this.#channels.get(channelId!)
      const owner = rest.join(':')
      return channel?.[kind]?.active(owner) === true ? [{ channel, owner }] : []
    }
    return [...this.#channels.values()].filter(c => c[kind]?.active(undefined) === true).map(channel => ({ channel, owner: undefined }))
  }

  approvalResolved(approvalId: string, outcome: string): void {
    this.#approvals.delete(approvalId)
    for (const channel of this.#channels.values()) void channel.approvals?.resolved(approvalId, outcome).catch(() => {})
  }

  /** The person a conversation belongs to just now (`channel:user`): the one who wrote to it last from a chat app. */
  #ownerKey(sessionId: string): string | undefined {
    return this.#speakers.get(sessionId) ?? this.#options.sessions.keyOf?.(sessionId)
  }

  /** A person answered an approval card. @returns false when someone else answered first. */
  respondApproval(approvalId: string, decision: 'allow-once' | 'reject', actor: Actor): boolean {
    const answered = this.#options.respondApproval(approvalId, decision)
    if (answered) this.#options.log.info(`${actor.channel}:${actor.userId} ${decision} approval ${approvalId}`)
    return answered
  }

  /** A reply while an approval waits for this person: 「同意」 allows it once, 「拒绝」 does not; anything else asks again. */
  #replyToApproval(approvalId: string, text: string, actor: Actor): string {
    const plain = text.replace(/[。.!！\s]/g, '')
    const decision = /^(同意|允许|可以|行|好的?|确认|ok|yes|y)$/i.test(plain) ? 'allow-once' as const
      : /^(拒绝|不同意|不行|不要|不可以|别|no|n)$/i.test(plain) ? 'reject' as const
      : undefined
    if (decision === undefined) return 'agent 在等你确认：回复「同意」允许这一次，或回复「拒绝」。'
    if (!this.respondApproval(approvalId, decision, actor)) return '这个操作已经在别处确认过了。'
    this.#approvals.delete(approvalId)
    return decision === 'allow-once' ? '已允许这一次。' : '已拒绝。'
  }

  // ── the agent's questions ─────────────────────────────────────────────

  askQuestion(request: QuestionRequested): void {
    const routes = this.#routes(request.sessionId, 'questions')
    if (routes.length === 0) return
    const key = this.#ownerKey(request.sessionId)
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

/** A kept notice as the app and 助手 see it. */
function shown({ told: _told, ...item }: KeptNotice): ChatNotice {
  return item
}

/**
 * What 助手 is told at the start of its next turn about the notices sent since (index.ts): what each said, what came of it,
 * and how to pick an action for the person (notice_act) when what they write answers one.
 */
export function noticesNote(items: readonly ChatNotice[], timeZone?: string): string {
  const clock = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', ...(timeZone === undefined ? {} : { timeZone }) })
  const lines = items.map((n, i) => {
    const text = n.text.length > 400 ? `${n.text.slice(0, 400)}…` : n.text
    const where = n.channels.length > 0 ? `发到了${n.channels.join('、')}，软件里也有` : '只在软件里'
    const state = n.acted !== undefined ? `已处理：${n.acted.by}选了「${n.acted.label}」——${n.acted.result}`
      : n.done !== undefined ? `已结束：${n.done}`
      : n.actions.length > 0 ? `等主人选：${n.actions.map(a => `「${a.label}」(action=${a.id})`).join(' ')}，notice=${n.id}`
      : '不需要回复'
    return `${i + 1}. 【${n.title}】${clock(n.at)}，${where}\n${text}\n（${state}）`
  })
  return [
    '（通知）在这之前，软件给主人发了这些通知；主人接下来的话可能是在回应它们：',
    ...lines,
    '主人的话是在回应某条还在等选择的通知时（例如「改吧」「好」「不用了」「停」），用 notice_act 替他选对应的操作，再告诉他结果；拿不准指哪条就问。跟通知无关就照常回答，不用提这些通知。',
  ].join('\n')
}

/** Put before each chat message to the agent: only its last message of the round reaches the person. */
export function channelNote(channel: string): string {
  return `（这条消息来自${CHANNEL_NAMES[channel] ?? channel}。只有你这一轮的最后一条消息会发给对方，中间的话和步骤对方看不到：最后用几句话总结这一轮——结论、做了什么、需要对方做什么。）`
}

const CHANNEL_NAMES: Readonly<Record<string, string>> = { feishu: '飞书', qq: 'QQ' }

/** What a person wrote, without the notes the app put before it for the agent (where it came from, how long it has been). */
export function personWords(text: string): string {
  return text.replace(/^（这条消息来自[^\n]*）\n/, '').replace(/^（距离这个对话的上一条消息已经过了[^\n]*）\n/, '').trim()
}

/** An approval as chat text, for channels without cards: what the agent wants to do, why, and how to answer. */
export function approvalText(request: ApprovalRequested): string {
  const reason = request.displayReason?.['zh-CN'] ?? request.displayReason?.['zh'] ?? request.reason
  return ['【需要你确认】', `agent 想要执行：${request.toolName}`, ...(reason === undefined ? [] : [`原因：${reason}`]), '回复「同意」允许这一次，回复「拒绝」不允许。也可以在软件里回答，先回答的生效。'].join('\n')
}

/** The agent's questions as chat text, for channels without cards: the first one, and how to answer. */
export function questionText(request: QuestionRequested): string {
  const first = request.questions[0]
  const more = request.questions.length > 1 ? `（共 ${request.questions.length} 个问题，答完一个发下一个）` : ''
  return ['【助手问你】' + more, first === undefined ? '' : describeQuestion(first), '回复选项的数字或文字，或直接写你的回答。'].join('\n')
}

/** A question as chat text: the question, then its choices numbered (reply with the number or the words). */
export function describeQuestion(item: QuestionItem): string {
  const options = item.options ?? []
  return [item.question, ...options.map((o, i) => `${i + 1}. ${o.label}${o.description === undefined ? '' : `（${o.description}）`}`)].join('\n')
}
