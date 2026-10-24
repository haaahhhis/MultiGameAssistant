/**
 * Conversations with the agent for chat channels, over dsh's session
 * controller: one session per person; a message is a prompt, the reply is that
 * turn as the app shows it (what the agent said and the steps between, see
 * reply.ts). A new session takes the model of the session the user used last
 * in the UI (dsh's default model may be one they never set up).
 *
 * A session keeps the folder it was created in as an absolute path: when that
 * folder is gone (renamed, moved), the session cannot work any more, so it
 * counts as not existing and the person gets a new one, with its last few
 * messages carried over (`recent`).
 */
import { existsSync } from 'node:fs'
import type { SessionController, SessionFollowFrame, SessionRequestId, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { convertRecord, convertRecords } from '@adg/gateway'
import { summarizeToolArgs } from '@adg/protocol'
import type { Conversations } from './notify.ts'
import { finalText, type Reply, type ReplyBlock, type ReplyStep } from './reply.ts'

type Sessions = Pick<SessionController, 'list' | 'create' | 'rename' | 'selectModel' | 'follow' | 'prompt' | 'projections'>
type SessionId = SessionSummary['sessionId']
type Snapshot = Extract<SessionFollowFrame, { type: 'snapshot' }>

/** Messages carried over when a conversation has to start again. */
const RECENT_MESSAGES = 10

/** @param cwd - the working folder new conversations get (the agent's own, see the gateway's workspaceDir). */
export function sessionConversations(sessions: Sessions, cwd: () => string | undefined = () => undefined): Conversations {
  const converse = async (sessionId: string, text: string, signal: AbortSignal, images: readonly Buffer[] = []): Promise<Reply> => {
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      const iterator = sessions.follow({ address: { kind: 'session', sessionId: sessionId as SessionId }, assistantStream: true, maxMessages: 1 }, controller.signal)[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done === true) throw new Error('会话没有打开')
      const requestId = `notify-${crypto.randomUUID()}`
      await sessions.prompt({
        requestId: requestId as SessionRequestId,
        sessionId: sessionId as SessionId,
        mode: 'queue',
        content: [{ type: 'text', text }, ...images.map(png => ({ type: 'image' as const, mediaType: 'image/png' as const, data: png.toString('base64') }))],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, controller.signal)
      return await turnReply(iterator, requestId, text)
    } finally {
      signal.removeEventListener('abort', abort)
      controller.abort()
    }
  }
  return {
    async create(title, options = {}) {
      const model = options.defaultModel === true ? undefined : await recentModel(sessions).catch(() => undefined)
      const dir = cwd()
      const created = await sessions.create(dir === undefined ? {} : { cwd: dir })
      await sessions.rename({ sessionId: created.sessionId, title }).catch(() => {})
      if (model !== undefined) await sessions.selectModel({ sessionId: created.sessionId, ...model }).catch(() => {})
      return created.sessionId
    },
    async exists(sessionId) {
      try {
        if ((await sessions.projections({ sessionId: sessionId as SessionId }, AbortSignal.timeout(10_000))) === null) return false
        const folder = (await snapshot(sessions, sessionId, 1))?.header.cwd
        return folder === undefined || existsSync(folder)
      } catch {
        return false
      }
    },
    async recent(sessionId) {
      const opened = await snapshot(sessions, sessionId, RECENT_MESSAGES).catch(() => undefined)
      if (opened === undefined) return undefined
      const lines = convertRecords(opened.records).flatMap(event => {
        if (event.type !== 'user/message' && event.type !== 'assistant/message') return []
        const said = event.content.map(p => (p.type === 'text' ? p.text : '')).join('').trim()
        if (said === '') return []
        return [`${event.type === 'user/message' ? '用户' : 'agent'}：${said.length > 400 ? `${said.slice(0, 400)}…` : said}`]
      })
      return lines.length === 0 ? undefined : lines.join('\n')
    },
    async ask(sessionId, text, signal, images) {
      return finalText(await converse(sessionId, text, signal, images)) || '（agent 没有回复文字）'
    },
    converse,
  }
}

/** The session's opening frame: its header (with its folder) and its last `maxMessages` records. */
async function snapshot(sessions: Sessions, sessionId: string, maxMessages: number): Promise<Snapshot | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const iterator = sessions.follow({ address: { kind: 'session', sessionId: sessionId as SessionId }, maxMessages }, controller.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    return first.done !== true && first.value.type === 'snapshot' ? first.value : undefined
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

type Selection = { provider: string; model: string; reasoningEffort?: string }

/** The model of the most recently active session that is not itself a chat-channel session. */
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

/**
 * Read events until the turn our message started ends: what the agent said
 * and the steps it took, in order — consecutive tool calls form one group,
 * like the app's 「执行了 N 个步骤」.
 */
async function turnReply(iterator: AsyncIterator<SessionFollowFrame>, requestId: string, text: string): Promise<Reply> {
  let mine = false
  const blocks: ReplyBlock[] = []
  /** Where each call's step is: its group in `blocks` and its place there. */
  const where = new Map<string, { block: number; index: number }>()
  const steps = (i: number) => (blocks[i] as { kind: 'steps'; steps: ReplyStep[] }).steps
  for (;;) {
    const next = await iterator.next()
    if (next.done === true) break
    if (next.value.type !== 'event') continue
    const event = convertRecord(next.value)
    if (event === null) continue
    if (event.type === 'user/message') {
      const body = event.content.map(p => (p.type === 'text' ? p.text : '')).join('')
      if (event.requestId === requestId || (event.requestId === undefined && body.trim() === text.trim())) mine = true
    } else if (mine && event.type === 'assistant/message') {
      const said = event.content.map(p => (p.type === 'text' ? p.text : '')).join('').trim()
      if (said !== '') blocks.push({ kind: 'text', text: said })
    } else if (mine && event.type === 'tool/call') {
      if (blocks.at(-1)?.kind !== 'steps') blocks.push({ kind: 'steps', steps: [] })
      const block = blocks.length - 1
      where.set(event.callId, { block, index: steps(block).length })
      steps(block).push({ name: event.name, summary: summarizeToolArgs(event.arguments), status: 'running' })
    } else if (mine && event.type === 'tool/result') {
      const at = where.get(event.callId)
      if (at !== undefined) steps(at.block)[at.index] = { ...steps(at.block)[at.index]!, status: event.isError ? 'error' : 'ok' }
    } else if (mine && event.type === 'turn/end') {
      if (event.reason.kind !== 'completed' && event.reason.kind !== 'stop' && finalText({ blocks }) === '') {
        blocks.push({ kind: 'text', text: `（这一轮没有完成：${event.reason.message ?? event.reason.kind}）` })
      }
      break
    }
  }
  return { blocks }
}
