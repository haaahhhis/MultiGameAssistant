/** Messages address a role's home. App tasks execute in native children of that home. */
import type { SessionController, SessionFollowFrame, SessionRequestId, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { convertRecord } from '@adg/gateway'
import { summarizeToolArgs, type HandOff } from '@adg/protocol'
import { createHandOffDesk, type HandOffDesk } from './handoff.ts'
import type { Conversations } from './notify.ts'
import { finalText, type Reply, type ReplyBlock, type ReplyStep } from './reply.ts'

type Sessions = Pick<SessionController, 'list' | 'follow' | 'prompt' | 'projections'> & Partial<Pick<SessionController, 'cancel' | 'updateQueue'>>
type SessionId = SessionSummary['sessionId']
/** The gateway's part: a new conversation's preset, role and model; each agent's own one; the hand-offs it keeps. */
interface AppSessions {
  runChild(owner: string, childId: string, title: string, instruction: string, signal: AbortSignal, images?: readonly Buffer[]): Promise<string>
  home(agentId: string): Promise<string>
  readonly handOffs: { put(item: HandOff): Promise<void>; all(): readonly HandOff[] }
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

/** Role tasks reserve a child ID before admission, so skill focus and cancellation belong to that task. */
export function sessionConversations(sessions: Sessions, _cwd: () => string | undefined = () => undefined, focus?: (sessionId: string, focus: { scripts?: string[]; games?: string[] }) => Promise<unknown>, app?: () => AppSessions | undefined): Conversations & Required<Pick<Conversations, 'converse' | 'prepareTask'>> {
  const converse = async (sessionId: string, text: string, signal: AbortSignal, images: readonly Buffer[] = [], options: { insert?: boolean; isolated?: boolean; onWorkerReport?: (text: string) => void } = {}): Promise<Reply> => {
    signal.throwIfAborted()
    const controller = new AbortController()
    const requestId = `notify-${crypto.randomUUID()}`
    const turn = { started: false }
    // Called off (a stopped run, a timeout): the agent's turn stops too, not only our following it —
    // an agent left running would go on acting (e.g. launch the game again). Still waiting behind
    // other work in the agent's one conversation, the message is taken back instead: the turn
    // running then is someone else's.
    let stopping: Promise<void> | undefined
    const abort = () => {
      controller.abort(signal.reason)
      stopping = Promise.resolve().then(async () => {
        if (turn.started || options.isolated) {
          try { await sessions.cancel?.({ sessionId: sessionId as SessionId }) }
          finally { app?.()?.stopSubAgents?.(sessionId) }
          if (!turn.started) await unqueue(sessions, sessionId, requestId)
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
      return await workReply(iterator, requestId, text, turn, settled === undefined ? undefined : () => settled.call(app!(), sessionId, controller.signal), options.onWorkerReport)
    } finally {
      signal.removeEventListener('abort', abort)
      controller.abort()
      await stopping
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
  const prepareTask = async (role: string, title: string, scope?: { scripts?: string[]; games?: string[] }) => {
    const owner = await gateway().home(role)
    const id = crypto.randomUUID()
    if (scope) await focus?.(id, scope)
    return { owner, id, run: (instruction: string, signal: AbortSignal, images?: readonly Buffer[]) =>
      gateway().runChild(owner, id, title, instruction, signal, images) }
  }
  let own: HandOffDesk | undefined
  const desk = (): HandOffDesk => {
    const found = app?.()
    const make = () => createHandOffDesk({ home, converse,
      prepareWorker: input => prepareTask(input.to.id, input.title, input.focus),
      record: item => gateway().handOffs.put(item), threads: () => gateway().handOffs.all() })
    if (found === undefined) return own ??= make()
    return (found.handOffDesk ??= make()) as HandOffDesk
  }
  return {
    home,
    get desk() { return desk() },
    handOff: input => desk().handOff(input),
    handOffRefusal: (fromSession, to, fromAgent, toName) => desk().refusal(fromSession, to, fromAgent, toName),
    askRefusal: sessionId => desk().askRefusal(sessionId),
    prepareTask,
    async lastActive(sessionId) {
      const { items } = await sessions.list({}, AbortSignal.timeout(10_000))
      return items.find(s => s.sessionId === sessionId)?.updatedAt
    },
    async ask(sessionId, text, signal, images) {
      const reply = await converse(sessionId, text, signal, images)
      signal.throwIfAborted()
      if (reply.ended !== undefined) throw new Error(reply.ended)
      const answer = finalText(reply)
      if (!answer.trim()) throw new Error('任务结束时没有返回结论')
      return answer
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
  #outcome: Reply['outcome']
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
        this.#outcome = ['aborted', 'interrupted'].includes(event.reason.kind) ? 'cancelled' : 'failed'
        // Its last words are then not a summary: say so after them (or instead of them, for whoever only takes the words).
        const why = `（这一轮没有完成：${endReason(event.reason)}）`
        if (finalText({ blocks }) === '') blocks.push({ kind: 'text', text: why })
        this.#ended = why
      } else this.#outcome = 'completed'
      return true
    }
    return false
  }

  get reply(): Reply {
    return { blocks: [...this.#blocks], ...(this.#outcome === undefined ? {} : { outcome: this.#outcome }), ...(this.#ended === undefined ? {} : { ended: this.#ended }) }
  }
}

/**
 * Read events until the work our message started is over (see {@link TurnReply}):
 * the end of its turn, or, when that turn opened sub-agents, the end of the
 * turns they wake once the agent is done (`settled`). The reply is all of it,
 * so its last words are what the agent concluded. A message from someone else
 * taking a turn in between is that turn's, not this work's. A turn whose
 * model failed and was switched to a fallback model goes on in the next turn.
 */
export async function workReply(iterator: AsyncIterator<SessionFollowFrame>, requestId: string, text: string, turn: { started: boolean }, settled: (() => Promise<void>) | undefined, onWorkerReport?: (text: string) => void): Promise<Reply> {
  const inbox: Record<string, (string | undefined)[]> = {}
  let cancelled = false
  let mine = false
  let other = false
  let opened = false
  let cut = false
  const turns: Reply[] = []
  let reply = new TurnReply()
  /** The event before was a model switch: the gateway's 备用模型 records it just before the failed turn's end (model-fallback.ts). */
  let switched = false
  const take = (frame: SessionFollowFrame): boolean => {
    if (frame.type !== 'event') return false
    if (!mine) {
      const record = frame.event as { type?: string; data?: { target?: string; start?: number; removedCount?: number; inserted?: { source?: { rpcId?: string } }[]; outcome?: string } }
      const splice = record.data
      if (record.type === 'agent/inbox/spliced' && splice?.target && typeof splice.start === 'number') {
        const items = inbox[splice.target] ??= []
        if (items.length < splice.start) items.length = splice.start
        const removed = items.splice(splice.start, splice.removedCount ?? 0, ...(splice.inserted ?? []).map(m => m.source?.rpcId))
        if (splice.outcome === 'canceled' && removed.includes(requestId)) { cancelled = true; return true }
      }
    }
    const event = convertRecord(frame)
    if (event === null) return false
    const afterSwitch = switched
    switched = event.type === 'unknown' && event.upstreamType === 'model/selection'
    if (event.type === 'user/message') {
      if (mine && !other && onWorkerReport) {
        const raw = frame.event as { data?: { source?: { kind?: string; stopReason?: string } } }
        const source = raw.data?.source
        if (source?.kind === 'subagent-settled' && source.stopReason === 'completed') {
          onWorkerReport(event.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
        }
      }
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
    if (event.type === 'turn/end' && event.reason.kind === 'error' && afterSwitch) {
      // The model failed and the agent goes on with a fallback model: the turn the card opens is this work's too.
      turns.push(reply.reply)
      reply = new TurnReply()
      return false
    }
    if (event.type === 'turn/end' && event.reason.kind !== 'completed' && event.reason.kind !== 'stop') cut = true
    if (!reply.add(event)) return false
    turns.push(reply.reply)
    reply = new TurnReply()
    return true
  }
  // Until our turn ends.
  for (;;) {
    const next = await iterator.next()
    if (next.done === true) return { ...joined(turns, reply), outcome: 'failed', ended: mine ? '会话在任务结束前断开' : '请求尚未运行，会话已结束' }
    if (take(next.value)) break
  }
  if (cancelled) return { blocks: [], outcome: 'cancelled', ended: '排队请求已取消' }
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
  const outcome = all.at(-1)?.outcome
  const ended = all.at(-1)?.ended
  return { blocks: all.flatMap(r => r.blocks), ...(outcome === undefined ? {} : { outcome }), ...(ended === undefined ? {} : { ended }) }
}
