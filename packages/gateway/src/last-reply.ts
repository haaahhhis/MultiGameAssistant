/**
 * What a session last said: the agent's last reply, shortened, for the
 * agent roster's second line and the role agents' task cards (docs/design/
 * agent-roles.md §9). Read from the session's last few records; kept per
 * session until it changes again. A running session's is read each time: its
 * reply can land without its updatedAt moving.
 */
import type { SessionController, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { convertRecords } from './convert.ts'

type Sessions = Pick<SessionController, 'follow'>
type SessionId = SessionSummary['sessionId']

/** How much of a reply a roster line or a card shows. */
const MAX_CHARS = 280
/** Records read back from a session's end to find its last reply. */
const READ_BACK = 6
const KEPT = 500

export class LastReplies {
  readonly #sessions: Sessions
  /** sessionId → the reply as of `at` (the session's updatedAt then). */
  readonly #cache = new Map<string, { readonly at: number; readonly text: string | null }>()

  constructor(sessions: Sessions) {
    this.#sessions = sessions
  }

  /** @param updatedAt - the session's last change: a newer one reads it again. */
  async of(sessionId: string, updatedAt: number, signal: AbortSignal, running = false): Promise<string | null> {
    const kept = this.#cache.get(sessionId)
    if (!running && kept !== undefined && kept.at >= updatedAt) return kept.text
    const text = await this.#read(sessionId, signal)
    this.#cache.delete(sessionId)
    if (running) return text
    this.#cache.set(sessionId, { at: updatedAt, text })
    while (this.#cache.size > KEPT) this.#cache.delete(this.#cache.keys().next().value!)
    return text
  }

  async #read(sessionId: string, signal: AbortSignal): Promise<string | null> {
    const controller = new AbortController()
    const stop = () => controller.abort()
    signal.addEventListener('abort', stop, { once: true })
    try {
      const iterator = this.#sessions.follow({ address: { kind: 'session', sessionId: sessionId as SessionId }, maxMessages: READ_BACK }, controller.signal)[Symbol.asyncIterator]()
      const first = await iterator.next()
      if (first.done === true || first.value.type !== 'snapshot') return null
      return lastReply(convertRecords(first.value.records))
    } catch {
      return null
    } finally {
      signal.removeEventListener('abort', stop)
      controller.abort()
    }
  }
}

/** The text of the last agent message that says something, as plain words on one line. */
export function lastReply(events: readonly { type: string; content?: readonly { type: string; text?: string }[] }[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'assistant/message') continue
    const text = (event.content ?? []).map(p => (p.type === 'text' ? p.text ?? '' : '')).join('').trim()
    if (text !== '') return plain(text)
  }
  return null
}

/** Markdown read as the words a one-line preview shows: no headings, emphasis, code marks, link targets or tables. */
export function plain(markdown: string): string {
  const words = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return words.length > MAX_CHARS ? `${words.slice(0, MAX_CHARS)}…` : words
}
