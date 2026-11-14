/**
 * The agent's own past conversations, word for word: `history_search` finds
 * where something was said, `history_read` reads a stretch around a message by
 * its number (#seq, the session's own event number), or around where a memory
 * entry was learned. What compaction (and low-context mode, low-context.ts)
 * took out of the agent's context is still in the session's durable log, and
 * summaries that were archived are kept in summaries.jsonl; these read both
 * back when what is in the context and the memory (memory.ts) are not enough.
 *
 * A search finds the messages holding every word; when none does, those
 * holding the most of them, so a question worded another way still finds
 * something to read.
 *
 * An agent reads its own conversations (a role's, or 助手's; a sub-agent its
 * lead's), not the other agents', and never a shared dsh's other chats.
 */
import { z } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SHARED_MEMORY, type MemoryEntry, type SessionEvent } from '@adg/protocol'
import type { ArchivedSummary } from './low-context.ts'
import { hasAll, termScore, termsOf } from './words.ts'

/**
 * What the harness adds to a step, not what anyone said: dsh's context blocks
 * (the runtime context, the skill catalog, the time, AGENTS.md and the like,
 * a referenced conversation, an invoked skill's instructions) and this app's
 * notes (the time reminder, recalled memory, what changed in the memory).
 */
export const HARNESS_NOTES: ReadonlySet<string> = new Set([
  'runtime-context', 'skill-catalog', 'time-context', 'agent-instructions', 'session-reference', 'skill-invocation',
  'adg-time', 'adg-recall', 'adg-memory',
])
/** How far back a search reads in one conversation. */
export const SEARCH_DEPTH = 1500
/** How many conversations a search reads, newest first. */
const SEARCH_SESSIONS = 20
/** Messages holding some of the words, kept while looking for one holding all. */
const MAX_PARTIAL = 500
const MAX_LINE = 1500
const SNIPPET = 160

export interface HistorySession {
  readonly id: string
  readonly title: string | null
  readonly updatedAt?: number
}

export interface HistoryDeps {
  /** The agent working in a session (memory.ts's owner); undefined: not one of the app's. */
  readonly agentOf: (sessionId: string) => string | undefined
  /** That agent's conversations, newest first. */
  readonly sessions: (agent: string, signal: AbortSignal) => Promise<readonly HistorySession[]>
  /** A conversation's records, oldest first, back to `maxMessages` messages. */
  readonly read: (sessionId: string, maxMessages: number, signal: AbortSignal) => Promise<readonly SessionEvent[]>
  /** A memory entry by id (memory.ts), to read where it was learned. */
  readonly memory?: (id: string) => MemoryEntry | undefined
  /** The summaries archived out of the context (low-context.ts). */
  readonly archived?: () => Promise<readonly ArchivedSummary[]>
  readonly timeZone?: string
}

export interface Said {
  readonly seq: number
  readonly time: number
  readonly from: 'user' | 'app' | 'agent'
  readonly text: string
  /** The compaction summary that replaced earlier messages. */
  readonly summary?: true
}

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').trim()
}

/** A summary's own words, without dsh's framing (its preamble to the model and the `<compacted-summary>` tags). */
export function unframed(text: string): string {
  const open = '<compacted-summary>'
  const at = text.indexOf(open)
  const end = text.lastIndexOf('</compacted-summary>')
  return at >= 0 && end > at ? text.slice(at + open.length, end).trim() : text
}

/** What was said, in order: the user's, the app's and other agents' messages, the agent's replies, the summaries. */
export function saidIn(events: readonly SessionEvent[]): Said[] {
  const out: Said[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (HARNESS_NOTES.has(event.origin.kind)) continue
      const text = event.replacesHistory === true ? unframed(textOf(event.content)) : textOf(event.content)
      if (text !== '') out.push({ seq: event.seq, time: event.time, from: event.origin.human ? 'user' : 'app', text, ...(event.replacesHistory === true ? { summary: true as const } : {}) })
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.content)
      if (text !== '') out.push({ seq: event.seq, time: event.time, from: 'agent', text })
    }
  }
  return out
}

/**
 * The log before the turn now running. What that turn holds is in the agent's
 * context already, the question it is answering first of all, which holds
 * every word it searches for and would come first in every search.
 */
export function beforeThisTurn(events: readonly SessionEvent[]): readonly SessionEvent[] {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === 'turn/start') return events.slice(0, i)
  return events
}

const WHO: Record<Said['from'], string> = { user: '用户', app: '软件/同事', agent: '你' }

function clock(time: number, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(time))
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** One message as a line: `#seq 日期 时间 谁：话`. */
export function line(said: Said, timeZone: string | undefined, max = MAX_LINE): string {
  const text = said.text.length > max ? `${said.text.slice(0, max)}…（后面省略 ${said.text.length - max} 字）` : said.text
  return `#${said.seq} ${clock(said.time, timeZone)} ${said.summary === true ? '（压缩摘要）' : WHO[said.from]}：${text}`
}

/** All the words in it (case aside)? */
export function matches(text: string, terms: readonly string[]): boolean {
  return hasAll(text, terms)
}

/** Around the first word found. */
export function snippet(text: string, terms: readonly string[]): string {
  const flat = text.replace(/\s+/g, ' ')
  const at = Math.max(0, ...terms.map(t => flat.toLowerCase().indexOf(t)).filter(i => i >= 0).slice(0, 1))
  const start = Math.max(0, at - SNIPPET / 2)
  const end = Math.min(flat.length, start + SNIPPET)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** The messages around `seq` (it, `before` before and `after` after). */
export function around(said: readonly Said[], seq: number, before: number, after: number): Said[] {
  let at = said.findIndex(s => s.seq >= seq)
  if (at === -1) at = said.length - 1
  return said.slice(Math.max(0, at - before), at + after + 1)
}

const SearchArgs = z.object({
  query: z.string().trim().min(1),
  days: z.number().int().min(1).max(3650).nullish(),
  session_id: z.string().nullish(),
  limit: z.number().int().min(1).max(50).nullish(),
})
const ReadArgs = z.object({
  seq: z.number().int().min(0).nullish(),
  memory_id: z.string().nullish(),
  session_id: z.string().nullish(),
  before: z.number().int().min(0).max(30).nullish(),
  after: z.number().int().min(0).max(30).nullish(),
})

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args ?? {})
  if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
  return parsed.data
}

const render = (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }]

/** One place a search found. */
interface Found {
  readonly session_id: string
  readonly title: string | null
  readonly seq: number
  readonly time: string
  readonly from: string
  readonly text: string
}

export function historyTools(deps: HistoryDeps): ToolDefinition[] {
  const caller = (exec: { agent?: { session: { id: string } } }): { agent: string; session: string } => {
    const session = exec.agent?.session.id
    const agent = session === undefined ? undefined : deps.agentOf(session)
    if (session === undefined || agent === undefined) throw new Error('只有本软件的 agent 能查对话记录')
    return { agent, session }
  }
  /** Its own conversations, this one first. */
  const reachable = async (agent: string, current: string, signal: AbortSignal): Promise<HistorySession[]> => {
    const all = await deps.sessions(agent, signal)
    const here = all.find(s => s.id === current) ?? { id: current, title: null }
    return [here, ...all.filter(s => s.id !== current)]
  }

  const search: ToolDefinition = {
    name: 'history_search',
    description: [
      '按关键词查你以前的对话原文（这个对话里被压缩掉的部分，和你更早的对话），也查已经归档、移出上下文的摘要。',
      '对话较早的部分可能已经压缩成了摘要或归档了：要用户的原话、具体的数字和名字、当时的输出时用它。',
      'query 写几个关键词（空格分开）：全部包含的优先；没有全部包含的，就列出包含得最多的。找到的每条带 #编号，用 history_read 读那一段的前后文。',
      '先查记忆（memory_search）；记忆里没有、或要原话时再查这里。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分开。' },
        days: { type: 'number', description: '只查最近几天（可选）。' },
        session_id: { type: 'string', description: '只查这个对话（可选；默认你所有的对话，这个对话在前）。' },
        limit: { type: 'number', description: '最多几条（默认 20）。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: {}, render },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const { agent, session } = caller(exec)
      const { query, days, session_id, limit } = parse(SearchArgs, args)
      const signal = exec.signal ?? new AbortController().signal
      const terms = termsOf(query)
      const since = days == null ? 0 : Date.now() - days * 24 * 60 * 60_000
      const sessions = (await reachable(agent, session, signal)).filter(s => session_id == null || s.id === session_id)
      if (session_id != null && sessions.length === 0) throw new Error(`没有这个对话：${session_id}（只能查你自己的对话）`)
      const max = limit ?? 20
      const titleOf = (s: HistorySession) => (s.id === session ? '（这个对话）' : s.title)
      const all: Found[] = []
      const some: { found: Found; score: number; at: number }[] = []
      const seen = new Set<string>()
      // A message holding every word is kept; one holding some, only while none holds all.
      const consider = (found: Found, text: string, at: number) => {
        seen.add(`${found.session_id}#${found.seq}`)
        if (hasAll(text, terms)) { all.push(found); return }
        if (all.length > 0 || some.length >= MAX_PARTIAL) return
        const score = termScore(text, terms)
        if (score > 0) some.push({ found, score, at })
      }
      for (const s of sessions.slice(0, SEARCH_SESSIONS)) {
        if (all.length >= max || signal.aborted) break
        const read = await deps.read(s.id, SEARCH_DEPTH, signal)
        const said = saidIn(s.id === session ? beforeThisTurn(read) : read)
        for (let i = said.length - 1; i >= 0 && all.length < max; i--) {
          const m = said[i]!
          if (m.time < since) break
          consider({ session_id: s.id, title: titleOf(s), seq: m.seq, time: clock(m.time, deps.timeZone), from: m.summary === true ? '压缩摘要' : WHO[m.from], text: snippet(m.text, terms) }, m.text, m.time)
        }
      }
      // Summaries archived out of the context: older than the log reads back, or already found there.
      if (all.length < max && deps.archived !== undefined) {
        const titles = new Map(sessions.map(s => [s.id, titleOf(s)]))
        const archived = (await deps.archived()).filter(a => titles.has(a.sessionId) && a.to >= since && !seen.has(`${a.sessionId}#${a.seq}`)).sort((a, b) => b.to - a.to)
        for (const a of archived) {
          if (all.length >= max) break
          consider({ session_id: a.sessionId, title: titles.get(a.sessionId) ?? null, seq: a.seq, time: `${clock(a.from, deps.timeZone)} 到 ${clock(a.to, deps.timeZone)}`, from: '归档摘要', text: snippet(a.text, terms) }, a.text, a.to)
        }
      }
      if (all.length > 0) return { items: all.slice(0, max), note: '用 history_read 的 seq（和 session_id）读前后文。' } as never
      const best = some.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, max).map(hit => hit.found)
      return best.length === 0
        ? { items: [], note: '没有找到。换个说法或更少的关键词再查；也可能就是没说过。' } as never
        : { items: best, note: '没有同时包含所有关键词的；下面是包含部分关键词的，按相关程度排，先看清楚是不是要找的，再用 history_read 读前后文。' } as never
    },
    presentCall: args => ({ card: 'generic', title: `查对话记录：${String((args as { query?: unknown } | undefined)?.query ?? '')}`, kind: 'other' }),
  }

  const read: ToolDefinition = {
    name: 'history_read',
    description: '读你以前对话里的一段原文：#编号（seq，来自 history_search、压缩摘要或归档说明）那条消息，和它前后几条；session_id 不写就是这个对话。或者给 memory_id（标着「可查原文」的记忆的 id），读记下那条记忆时的对话。',
    parameters: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: '消息的编号（#后面的数字）。不给 memory_id 时必填。' },
        memory_id: { type: 'string', description: '一条记忆的 id：读记下它时的对话（可选，代替 seq 和 session_id）。' },
        session_id: { type: 'string', description: '哪个对话（可选，默认这个对话）。' },
        before: { type: 'number', description: '往前读几条（默认 4）。' },
        after: { type: 'number', description: '往后读几条（默认 4）。' },
      },
      additionalProperties: false,
    },
    output: { schema: {}, render },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const { agent, session } = caller(exec)
      const { seq: askedSeq, memory_id, session_id, before, after } = parse(ReadArgs, args)
      const signal = exec.signal ?? new AbortController().signal
      let target = session_id ?? session
      let seq = askedSeq ?? undefined
      if (memory_id != null && memory_id !== '') {
        const entry = deps.memory?.(memory_id)
        if (entry === undefined || (entry.scope !== SHARED_MEMORY && entry.scope !== agent)) throw new Error(`没有这条记忆：${memory_id}（用 memory_search 查 id）`)
        if (entry.source === undefined) throw new Error('这条记忆没有记下出处（是在设置里写的，或者是很早以前记的）：用 history_search 按关键词查')
        if (entry.source.agent !== agent) throw new Error('这条记忆是在别的 agent 的对话里记下的，你读不到那里的原文：要细节可以问那个 agent')
        target = entry.source.sessionId
        seq = entry.source.seq
      }
      if (seq === undefined) throw new Error('要给 seq（消息的编号），或者 memory_id')
      if (target !== session && !(await deps.sessions(agent, signal)).some(s => s.id === target)) throw new Error(`没有这个对话：${target}（只能读你自己的对话；可能已经删掉了）`)
      // Read back far enough to reach it: the newest messages first, then further.
      let said: Said[] = []
      for (const depth of [400, SEARCH_DEPTH, 10_000]) {
        said = saidIn(await deps.read(target, depth, signal))
        if (said.length === 0 || said[0]!.seq <= seq) break
      }
      if (said.length === 0) return '这个对话里还没有消息。' as never
      const picked = around(said, seq, before ?? 4, after ?? 4)
      return [`对话 ${target === session ? '（这个对话）' : target}，#${picked[0]!.seq}–#${picked.at(-1)!.seq}：`, ...picked.map(s => line(s, deps.timeZone))].join('\n\n') as never
    },
    presentCall: args => {
      const a = (args ?? {}) as { seq?: unknown; memory_id?: unknown }
      return { card: 'generic', title: a.memory_id != null ? '读记下这条记忆时的对话' : `读对话记录 #${String(a.seq ?? '')}`, kind: 'other' }
    },
  }
  return [search, read]
}
