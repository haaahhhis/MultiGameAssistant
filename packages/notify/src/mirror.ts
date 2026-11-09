/**
 * 助手's conversation, carried to the chat apps as it goes (远程连接,
 * docs/design/agent-roles.md §13), so the app and every allowed chat person
 * see the same conversation. Each message comes over as text:
 *
 * - what was typed in the app (你（软件）：…), or written from a chat app by
 *   someone else (张三（飞书）：…);
 * - work handed to 助手 (定时任务 → 助手：…), and a reminder it set coming due (定时提醒：…);
 * - each message between 助手 and another agent, as one line
 *   (助手 → 游戏：…, 游戏 → 助手：…（交回了）) — the words stay in the app;
 * - each of 助手's replies, as the round's summary (reply.ts) — what the
 *   person who wrote gets as the answer. A reply saying there is nothing to
 *   tell (QUIET) is not sent.
 *
 * The person whose own message or answer it is does not get it again.
 */
import type { SessionController, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { convertRecord } from '@adg/gateway'
import { BY_YOU, isQuiet, parseRelay, parseTask, parseThreadNote, reminderLine, reminderPrompts, type HandOff } from '@adg/protocol'
import { TurnReply, type ConversationEvent } from './conversations.ts'
import { personWords, type Actor, type MirrorPost } from './notify.ts'
import { finalText, replyMarkdown, type Reply } from './reply.ts'

type SessionId = SessionSummary['sessionId']

export interface MirrorDeps {
  readonly sessions: () => Pick<SessionController, 'follow'> | undefined
  /** 助手's one conversation (the gateway's home). */
  readonly home: () => Promise<string>
  /** Who sent this message from a chat app (Notify.originOf); undefined: someone in the app. */
  readonly originOf: (text: string) => Actor | undefined
  /** A channel's name for people (飞书). */
  readonly channelName: (channelId: string) => string
  /** An agent's name, from its role id. */
  readonly agentName: (agentId: string) => string
  readonly post: (post: MirrorPost, except?: Actor) => void
  readonly log: { warn(message: string): void }
  /** Before following again after the stream ended or failed. @default 5000 */
  readonly retryMs?: number
}

/** 助手, as people call it. */
const MAIN_NAME = '助手'
/** Hand-offs whose last state was mirrored, at most. */
const KEEP_SEEN = 200

export class HomeMirror {
  readonly #deps: MirrorDeps
  readonly #controller = new AbortController()
  #home: string | undefined
  #turn: { origin: Actor | undefined; reply: TurnReply } | undefined
  readonly #seen = new Map<string, HandOff['state']>()

  constructor(deps: MirrorDeps) {
    this.#deps = deps
  }

  /** Follow 助手's conversation until {@link stop}; following again whenever the stream ends. */
  start(): void {
    void this.#loop()
  }

  stop(): void {
    this.#controller.abort()
  }

  async #loop(): Promise<void> {
    const signal = this.#controller.signal
    while (!signal.aborted) {
      try {
        const sessions = this.#deps.sessions()
        if (sessions !== undefined) {
          const home = await this.#deps.home()
          this.#home = home
          // The snapshot first (what was said before: not news), then each event as it happens.
          for await (const frame of sessions.follow({ address: { kind: 'session', sessionId: home as SessionId }, maxMessages: 1 }, signal)) {
            if (frame.type !== 'event') continue
            const event = convertRecord(frame)
            if (event !== null) this.event(event)
          }
        }
      } catch (error) {
        if (!signal.aborted) this.#deps.log.warn(`following 助手's conversation for the chat apps failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      this.#turn = undefined
      await new Promise(resolve => {
        const timer = setTimeout(resolve, this.#deps.retryMs ?? 5000)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined) }, { once: true })
      })
    }
  }

  /** One event of 助手's conversation, as it happens. */
  event(event: ConversationEvent): void {
    if (event.type === 'user/message') {
      // What dsh and the app put in for the model (the time, a reminder 助手 set, a summary) is not shown as a
      // message, here or in the app — but the turn it starts is 助手's like any other, and its reply goes out.
      const text = event.content.map(p => (p.type === 'text' ? p.text : '')).join('')
      const origin = event.origin.human ? this.#message(text) : undefined
      // A reminder coming due shows as a line in the app; the same line here.
      const reminder = event.origin.human ? undefined : reminderPrompts(text)
      if (reminder !== undefined) this.#deps.post({ text: reminderLine(reminder) })
      // A message while the turn runs (steering) joins it; the turn's reply goes to whoever wrote first in it.
      this.#turn ??= { origin: undefined, reply: new TurnReply() }
      this.#turn.origin ??= origin
      return
    }
    // A turn already going when the mirror started following: its reply goes out all the same.
    this.#turn ??= { origin: undefined, reply: new TurnReply() }
    if (!this.#turn.reply.add(event)) return
    const { origin, reply } = this.#turn
    this.#turn = undefined
    this.#reply(reply.reply, origin)
  }

  /** A hand-off (the gateway's); 助手's (from its conversation) become lines. */
  handOff(item: HandOff): void {
    // Waiting on an answer is the same work still going: its question comes over as a message of the conversation.
    if (item.state === 'waiting' || this.#home === undefined || item.fromSession !== this.#home || this.#seen.get(item.id) === item.state) return
    if (item.state === 'running' && this.#seen.has(item.id)) return
    this.#seen.set(item.id, item.state)
    while (this.#seen.size > KEEP_SEEN) this.#seen.delete(this.#seen.keys().next().value!)
    const to = this.#deps.agentName(item.to)
    this.#deps.post({ text: item.state === 'running' ? `${item.by} → ${to}：${item.title}` : `${to} → ${item.by}：${item.title}（${item.state === 'done' ? '交回了' : '没有做完'}）` })
  }

  /** @returns who wrote it from a chat app, if someone did. */
  #message(text: string): Actor | undefined {
    // A reply coming back: its line went out with the hand-off.
    if (parseRelay(text) !== undefined) return undefined
    const said = parseThreadNote(text)
    if (said !== undefined) {
      this.#deps.post({ text: `${said.from} → ${MAIN_NAME}：${said.kind === 'question' ? '问' : '答'}：${said.text}` })
      return undefined
    }
    const task = parseTask(text)
    if (task !== undefined) {
      this.#deps.post({ text: task.by === BY_YOU ? `你（软件）点了：${task.title}` : `${task.by} → ${MAIN_NAME}：${task.title}` })
      return undefined
    }
    const origin = this.#deps.originOf(text)
    const words = personWords(text)
    if (words === '') return origin
    if (origin === undefined) this.#deps.post({ text: `你（软件）：${words}` })
    else this.#deps.post({ text: `${origin.name ?? '对方'}（${this.#deps.channelName(origin.channel)}）：${words}` }, origin)
    return origin
  }

  #reply(reply: Reply, origin: Actor | undefined): void {
    const words = finalText(reply).trim()
    const stepped = reply.blocks.some(b => b.kind === 'steps')
    if ((words === '' && !stepped) || isQuiet(words)) return
    this.#deps.post({ text: replyMarkdown(reply), markdown: true }, origin)
  }
}
