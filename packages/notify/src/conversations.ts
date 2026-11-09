/**
 * Conversations with the agents, over dsh's session controller: a message is
 * a prompt, the reply is that turn as the app shows it (what the agent said
 * and the steps between, see reply.ts). Each agent has one conversation (the
 * gateway's `home`): work handed to it is a message there, and a message sent
 * while it is busy waits its turn (docs/design/agent-roles.md §10). A new
 * one-off session takes the model of the session the user used last in the UI
 * (dsh's default model may be one they never set up).
 */
import type { SessionController, SessionFollowFrame, SessionRequestId, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { convertRecord } from '@adg/gateway'
import { summarizeToolArgs, type HandOff } from '@adg/protocol'
import { createHandOffDesk, type HandOffDesk } from './handoff.ts'
import type { Conversations } from './notify.ts'
import { finalText, type Reply, type ReplyBlock, type ReplyStep } from './reply.ts'

type Sessions = Pick<SessionController, 'list' | 'create' | 'rename' | 'selectModel' | 'follow' | 'prompt' | 'projections'> & Partial<Pick<SessionController, 'cancel' | 'updateQueue'>>
type SessionId = SessionSummary['sessionId']
/** The gateway's part: a new conversation's preset, role and model; each agent's own one; the hand-offs it keeps. */
interface AppSessions {
  sessionPreset(): { agentPreset?: string }
  adopt(sessionId: string): Promise<void>
  tagSession(sessionId: string, role: string, by?: string): Promise<void>
  roleModel(role: string): { provider: string; model: string; reasoningEffort?: string | undefined } | undefined
  home(agentId: string): Promise<string>
  readonly handOffs: { put(item: HandOff): Promise<void> }
  /** Resolves once the agent there is done, its sub-agents back and its reply to them given. */
  settled?(sessionId: string, signal: AbortSignal): Promise<void>
  stopSubAgents?(sessionId: string): void
  /** The one desk the threads between agents are kept on (see below): the gateway only holds it. */
  handOffDesk?: unknown
}

/** dsh's tools that start a sub-agent: a turn that used one is not the end of the work. */
const SUB_AGENT_TOOLS: ReadonlySet<string> = new Set(['subagent', 'subagent_fork'])

/** How long the events of a settled agent get to arrive after it is known to be done. */
const QUIET_MS = 250

/**
 * @param cwd - the working folder new conversations get (the agent's own, see the gateway's workspaceDir).
 * @param focus - set what a new conversation is about (the gateway's skill scope), for `create`'s `focus`.
 * @param app - the gateway, for a new conversation's agent preset, to count it as the app's (a dsh shared with other work), and to put it under its role agent with that role's model.
 */
export function sessionConversations(sessions: Sessions, cwd: () => string | undefined = () => undefined, focus?: (sessionId: string, focus: { scripts?: string[]; games?: string[] }) => Promise<unknown>, app?: () => AppSessions | undefined): Conversations {
  const converse = async (sessionId: string, text: string, signal: AbortSignal, images: readonly Buffer[] = [], options: { insert?: boolean } = {}): Promise<Reply> => {
    const controller = new AbortController()
    const requestId = `notify-${crypto.randomUUID()}`
    const turn = { started: false }
    // Called off (a stopped run, a timeout): the agent's turn stops too, not only our following it —
    // an agent left running would go on acting (e.g. launch the game again). Still waiting behind
    // other work in the agent's one conversation, the message is taken back instead: the turn
    // running then is someone else's.
    const abort = () => {
      controller.abort(signal.reason)
      void Promise.resolve().then(async () => {
        if (turn.started) {
          sessions.cancel?.({ sessionId: sessionId as SessionId })
          app?.()?.stopSubAgents?.(sessionId)
        } else await unqueue(sessions, sessionId, requestId)
      }).catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const iterator = sessions.follow({ address: { kind: 'session', sessionId: sessionId as SessionId }, assistantStream: true, maxMessages: 1 }, controller.signal)[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done === true) throw new Error('会话没有打开')
      await sessions.prompt({
        requestId: requestId as SessionRequestId,
        sessionId: sessionId as SessionId,
        mode: options.insert === true && await running(sessions, sessionId, controller.signal) ? 'steer' : 'queue',
        content: [{ type: 'text', text }, ...images.map(png => ({ type: 'image' as const, mediaType: 'image/png' as const, data: png.toString('base64') }))],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, controller.signal)
      const settled = app?.()?.settled
      return await workReply(iterator, requestId, text, turn, settled === undefined ? undefined : () => settled.call(app!(), sessionId, controller.signal))
    } finally {
      signal.removeEventListener('abort', abort)
      controller.abort()
    }
  }
  const gateway = (): AppSessions => {
    const found = app?.()
    if (found === undefined) throw new Error('agent 现在不可用（网关没有加载）')
    return found
  }
  const home = async (agent: string, options: { focus?: { scripts?: string[]; games?: string[] } } = {}): Promise<string> => {
    const sessionId = await gateway().home(agent)
    if (options.focus !== undefined) await focus?.(sessionId, options.focus)
    return sessionId
  }
  // One desk for all the app's plugins, each with conversations of its own: a thread is between agents, not between plugins.
  let own: HandOffDesk | undefined
  const desk = (): HandOffDesk => {
    const found = app?.()
    const make = () => createHandOffDesk({ home, converse, record: item => gateway().handOffs.put(item) })
    if (found === undefined) return own ??= make()
    return (found.handOffDesk ??= make()) as HandOffDesk
  }
  return {
    home,
    get desk() { return desk() },
    handOff: input => desk().handOff(input),
    handOffRefusal: (fromSession, to, fromAgent, toName) => desk().refusal(fromSession, to, fromAgent, toName),
    askRefusal: sessionId => desk().askRefusal(sessionId),
    async create(title, options = {}) {
      // A role agent's session: the model chosen for role agents, when there is one (设置 → 模型).
      const chosen = options.role === undefined ? undefined : app?.()?.roleModel(options.role)
      const roleModel: Selection | undefined = chosen === undefined ? undefined : { provider: chosen.provider, model: chosen.model, ...(chosen.reasoningEffort === undefined ? {} : { reasoningEffort: chosen.reasoningEffort }) }
      const model = roleModel ?? (options.defaultModel === true ? undefined : await recentModel(sessions).catch(() => undefined))
      const dir = cwd()
      const created = await sessions.create({ ...(dir === undefined ? {} : { cwd: dir }), ...app?.()?.sessionPreset() })
      await app?.()?.adopt(created.sessionId)
      if (options.role !== undefined) await app?.()?.tagSession(created.sessionId, options.role, options.by)
      await sessions.rename({ sessionId: created.sessionId, title }).catch(() => {})
      if (model !== undefined) await sessions.selectModel({ sessionId: created.sessionId, ...model }).catch(() => {})
      if (options.focus !== undefined) await focus?.(created.sessionId, options.focus)
      return created.sessionId
    },
    async lastActive(sessionId) {
      const { items } = await sessions.list({}, AbortSignal.timeout(10_000))
      return items.find(s => s.sessionId === sessionId)?.updatedAt
    },
    async ask(sessionId, text, signal, images) {
      return finalText(await converse(sessionId, text, signal, images)) || '（agent 没有回复文字）'
    },
    converse,
  }
}

/** Whether the conversation has a turn going for a message to go into. */
async function running(sessions: Sessions, sessionId: string, signal: AbortSignal): Promise<boolean> {
  const { items } = await sessions.list({}, signal)
  return items.find(s => s.sessionId === sessionId)?.running === true
}

/** Take a message that has not been started yet back out of the conversation's queue. */
async function unqueue(sessions: Sessions, sessionId: string, requestId: string): Promise<void> {
  if (sessions.updateQueue === undefined) return
  const values = (await sessions.projections({ sessionId: sessionId as SessionId }, AbortSignal.timeout(10_000)))?.values as { inbox?: Record<string, unknown> } | undefined
  for (const list of Object.values(values?.inbox ?? {})) {
    if (!Array.isArray(list)) continue
    const queued = (list as { id?: unknown; source?: { rpcId?: unknown } }[]).find(m => m.source?.rpcId === requestId)
    if (typeof queued?.id === 'string') await sessions.updateQueue({ sessionId: sessionId as SessionId, itemId: queued.id as never, action: { kind: 'remove' } })
  }
}

type Selection = { provider: string; model: string; reasoningEffort?: string }

/** The model of the most recently active session that is not itself a chat-channel session. */
/** Why a turn ended early, for people (dsh gives a kind, and for interruptions who caused it). */
export function endReason(reason: { kind: string; message?: string | undefined }): string {
  const BY: Readonly<Record<string, string>> = {
    user: '被打断了（用户发了新消息或点了停止）', 'user-rpc': '被打断了（另一个窗口发了新消息或点了停止）', timeout: '超时了', shutdown: '程序退出了',
  }
  const KIND: Readonly<Record<string, string>> = {
    aborted: '已停止', interrupted: '被打断了', blocked: '被拦下了', 'max-tokens': '回复太长，达到了输出上限', error: '出错了',
  }
  const message = reason.message?.trim()
  if (message !== undefined && /no API key/i.test(message)) return '模型还没有填 Key：在「设置 → 模型」里添加模型服务并填好 Key'
  if (message !== undefined && message !== '') return BY[message] ?? message
  return KIND[reason.kind] ?? reason.kind
}

async function recentModel(sessions: Sessions): Promise<Selection | undefined> {
  const { items } = await sessions.list({}, AbortSignal.timeout(10_000))
  const recent = [...items].sort((a, b) => b.updatedAt - a.updatedAt).filter(s => !/^(飞书|feishu)：/.test(String(s.projections?.values?.['title'] ?? ''))).slice(0, 5)
  for (const summary of recent) {
    const values = summary.projections?.values ?? (await sessions.projections({ sessionId: summary.sessionId }, AbortSignal.timeout(10_000)))?.values
    const selection = pick((values as Record<string, unknown> | undefined)?.['modelSelection'])
    if (selection !== undefined) return selection
  }
  return undefined
}

function pick(value: unknown): Selection | undefined {
  const v = (value ?? {}) as { next?: unknown; lastUsed?: unknown }
  for (const candidate of [v.next, v.lastUsed]) {
    const c = candidate as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined
    if (typeof c?.provider === 'string' && typeof c.model === 'string') {
      return { provider: c.provider, model: c.model, ...(typeof c.reasoningEffort === 'string' ? { reasoningEffort: c.reasoningEffort } : {}) }
    }
  }
  return undefined
}

/** One event of a conversation, as the gateway reads dsh's records. */
export type ConversationEvent = NonNullable<ReturnType<typeof convertRecord>>

/**
 * A turn's reply, built as its events come: what the agent said and the steps
 * it took, in order — consecutive tool calls form one group, like the app's
 * 「执行了 N 个步骤」.
 */
export class TurnReply {
  readonly #blocks: ReplyBlock[] = []
  /** Where each call's step is: its group in `blocks` and its place there. */
  readonly #where = new Map<string, { block: number; index: number }>()
  #ended: string | undefined

  /** @returns true once the turn has ended. */
  add(event: ConversationEvent): boolean {
    const blocks = this.#blocks
    const steps = (i: number) => (blocks[i] as { kind: 'steps'; steps: ReplyStep[] }).steps
    if (event.type === 'assistant/message') {
      const said = event.content.map(p => (p.type === 'text' ? p.text : '')).join('').trim()
      if (said !== '') blocks.push({ kind: 'text', text: said })
    } else if (event.type === 'tool/call') {
      if (blocks.at(-1)?.kind !== 'steps') blocks.push({ kind: 'steps', steps: [] })
      const block = blocks.length - 1
      this.#where.set(event.callId, { block, index: steps(block).length })
      steps(block).push({ name: event.name, summary: summarizeToolArgs(event.arguments), status: 'running' })
    } else if (event.type === 'tool/result') {
      const at = this.#where.get(event.callId)
      if (at !== undefined) steps(at.block)[at.index] = { ...steps(at.block)[at.index]!, status: event.isError ? 'error' : 'ok' }
    } else if (event.type === 'turn/end') {
      if (event.reason.kind !== 'completed' && event.reason.kind !== 'stop') {
        // Its last words are then not a summary: say so after them (or instead of them, for whoever only takes the words).
        const why = `（这一轮没有完成：${endReason(event.reason)}）`
        if (finalText({ blocks }) === '') blocks.push({ kind: 'text', text: why })
        else this.#ended = why
      }
      return true
    }
    return false
  }

  get reply(): Reply {
    return this.#ended === undefined ? { blocks: [...this.#blocks] } : { blocks: [...this.#blocks], ended: this.#ended }
  }
}

/**
 * Read events until the work our message started is over (see {@link TurnReply}):
 * the end of its turn, or, when that turn opened sub-agents, the end of the
 * turns they wake once the agent is done (`settled`). The reply is all of it,
 * so its last words are what the agent concluded. A message from someone else
 * taking a turn in between is that turn's, not this work's.
 */
export async function workReply(iterator: AsyncIterator<SessionFollowFrame>, requestId: string, text: string, turn: { started: boolean }, settled: (() => Promise<void>) | undefined): Promise<Reply> {
  let mine = false
  let other = false
  let opened = false
  let cut = false
  const turns: Reply[] = []
  let reply = new TurnReply()
  const take = (frame: SessionFollowFrame): boolean => {
    if (frame.type !== 'event') return false
    const event = convertRecord(frame)
    if (event === null) return false
    if (event.type === 'user/message') {
      const body = event.content.map(p => (p.type === 'text' ? p.text : '')).join('')
      if (event.requestId === requestId || (event.requestId === undefined && !mine && body.trim() === text.trim())) mine = turn.started = true
      else if (mine && turns.length > 0) other = event.requestId !== undefined
      return false
    }
    if (!mine || other) {
      if (event.type === 'turn/end') other = false
      return false
    }
    if (event.type === 'tool/call' && SUB_AGENT_TOOLS.has(event.name)) opened = true
    if (event.type === 'turn/end' && event.reason.kind !== 'completed' && event.reason.kind !== 'stop') cut = true
    if (!reply.add(event)) return false
    turns.push(reply.reply)
    reply = new TurnReply()
    return true
  }
  // Until our turn ends.
  for (;;) {
    const next = await iterator.next()
    if (next.done === true) return joined(turns, reply)
    if (take(next.value)) break
  }
  if (!opened || settled === undefined || cut) return joined(turns, reply)
  // Then whatever its sub-agents wake, until the agent is done. Events may trail that a little.
  let done = false
  const finished = settled().then(() => { done = true })
  let pending: Promise<IteratorResult<SessionFollowFrame>> | undefined
  for (;;) {
    pending ??= iterator.next()
    const raced = await Promise.race(done
      ? [pending, new Promise<null>(resolve => setTimeout(() => resolve(null), QUIET_MS))]
      : [pending, finished.then(() => undefined)])
    if (raced === null) break
    if (raced === undefined) continue
    pending = undefined
    if (raced.done === true) break
    take(raced.value)
  }
  return joined(turns, reply)
}

/** Several turns as one reply; how the last of them ended is how the work ended. */
function joined(turns: readonly Reply[], unfinished: TurnReply): Reply {
  const open = unfinished.reply
  const all = open.blocks.length > 0 ? [...turns, open] : turns
  const ended = all.at(-1)?.ended
  return { blocks: all.flatMap(r => r.blocks), ...(ended === undefined ? {} : { ended }) }
}
