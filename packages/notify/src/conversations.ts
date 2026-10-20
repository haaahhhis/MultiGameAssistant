/**
 * Conversations with the agent for chat channels, over dsh's session
 * controller: one session per person; a message is a prompt, the reply is the
 * agent's last assistant message of that turn. A new session takes the model
 * of the session the user used last in the UI (dsh's default model may be one
 * they never set up).
 */
import type { SessionController, SessionFollowFrame, SessionRequestId, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { convertRecord } from '@adg/gateway'
import type { Conversations } from './notify.ts'

type Sessions = Pick<SessionController, 'list' | 'create' | 'rename' | 'selectModel' | 'follow' | 'prompt' | 'projections'>
type SessionId = SessionSummary['sessionId']

/** @param cwd - the working folder new conversations get (the agent's own, see the gateway's workspaceDir). */
export function sessionConversations(sessions: Sessions, cwd: () => string | undefined = () => undefined): Conversations {
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
        return (await sessions.projections({ sessionId: sessionId as SessionId }, AbortSignal.timeout(10_000))) !== null
      } catch {
        return false
      }
    },
    async ask(sessionId, text, signal, images = []) {
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
        return await finalAnswer(iterator, requestId, text)
      } finally {
        signal.removeEventListener('abort', abort)
        controller.abort()
      }
    },
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

/** Read events until the turn our message started ends; the last assistant text is the answer. */
async function finalAnswer(iterator: AsyncIterator<SessionFollowFrame>, requestId: string, text: string): Promise<string> {
  let mine = false
  let answer = ''
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
      if (said !== '') answer = said
    } else if (mine && event.type === 'turn/end') {
      if (event.reason.kind !== 'completed' && event.reason.kind !== 'stop' && answer === '') {
        return `（这一轮没有完成：${event.reason.message ?? event.reason.kind}）`
      }
      break
    }
  }
  return answer === '' ? '（agent 没有回复文字）' : answer
}
