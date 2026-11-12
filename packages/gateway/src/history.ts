/**
 * The agent's own past conversations, word for word: `history_search` finds
 * where something was said, `history_read` reads a stretch around a message by
 * its number (#seq, the session's own event number). What compaction (and
 * low-context mode, low-context.ts) took out of the agent's context is still
 * in the session's durable log; these read it back when the summary and the
 * memory (memory.ts) are not enough.
 *
 * An agent reads its own conversations (a role's, or 助手's; a sub-agent its
 * lead's), not the other agents', and never a shared dsh's other chats.
 */
import { z } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@adg/protocol'

/** Notes the harness adds to a step: not what anyone said. */
const NOTE_SOURCES = new Set(['time-context', 'adg-time'])
/** How far back a search reads in one conversation. */
export const SEARCH_DEPTH = 1500
/** How many conversations a search reads, newest first. */
const SEARCH_SESSIONS = 20
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

/** What was said, in order: the user's, the app's and other agents' messages, the agent's replies, the summaries. */
export function saidIn(events: readonly SessionEvent[]): Said[] {
  const out: Said[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (NOTE_SOURCES.has(event.origin.kind)) continue
      const text = textOf(event.content)
      if (text !== '') out.push({ seq: event.seq, time: event.time, from: event.origin.human ? 'user' : 'app', text, ...(event.replacesHistory === true ? { summary: true as const } : {}) })
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.content)
      if (text !== '') out.push({ seq: event.seq, time: event.time, from: 'agent', text })
    }
  }
  return out
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
  const lower = text.toLowerCase()
  return terms.every(term => lower.includes(term))
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
  seq: z.number().int().min(0),
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
      '按关键词查你以前的对话原文（这个对话里被压缩掉的部分，和你更早的对话）。',
      '对话较早的部分可能已经压缩成了摘要：要用户的原话、具体的数字和名字、当时的输出时用它。',
      'query 写几个关键词（空格分开，全部包含才算）；找到的每条带 #编号，用 history_read 读那一段的前后文。',
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
      const terms = query.toLowerCase().split(/\s+/).filter(t => t !== '')
      const since = days == null ? 0 : Date.now() - days * 24 * 60 * 60_000
      const sessions = (await reachable(agent, session, signal)).filter(s => session_id == null || s.id === session_id)
      if (session_id != null && sessions.length === 0) throw new Error(`没有这个对话：${session_id}（只能查你自己的对话）`)
      const max = limit ?? 20
      const items: { session_id: string; title: string | null; seq: number; time: string; from: string; text: string }[] = []
      for (const s of sessions.slice(0, SEARCH_SESSIONS)) {
        if (items.length >= max || signal.aborted) break
        const said = saidIn(await deps.read(s.id, SEARCH_DEPTH, signal))
        for (let i = said.length - 1; i >= 0 && items.length < max; i--) {
          const m = said[i]!
          if (m.time < since) break
          if (!matches(m.text, terms)) continue
          items.push({ session_id: s.id, title: s.id === session ? '（这个对话）' : s.title, seq: m.seq, time: clock(m.time, deps.timeZone), from: m.summary === true ? '压缩摘要' : WHO[m.from], text: snippet(m.text, terms) })
        }
      }
      return items.length === 0
        ? { items, note: '没有找到。换个说法或更少的关键词再查；也可能就是没说过。' } as never
        : { items, note: '用 history_read 的 seq（和 session_id）读前后文。' } as never
    },
    presentCall: args => ({ card: 'generic', title: `查对话记录：${String((args as { query?: unknown } | undefined)?.query ?? '')}`, kind: 'other' }),
  }

  const read: ToolDefinition = {
    name: 'history_read',
    description: '读你以前对话里的一段原文：#编号（seq，来自 history_search 或压缩摘要）那条消息，和它前后几条。session_id 不写就是这个对话。',
    parameters: {
      type: 'object',
      properties: {
        seq: { type: 'number', description: '消息的编号（#后面的数字）。' },
        session_id: { type: 'string', description: '哪个对话（可选，默认这个对话）。' },
        before: { type: 'number', description: '往前读几条（默认 4）。' },
        after: { type: 'number', description: '往后读几条（默认 4）。' },
      },
      required: ['seq'],
      additionalProperties: false,
    },
    output: { schema: {}, render },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const { agent, session } = caller(exec)
      const { seq, session_id, before, after } = parse(ReadArgs, args)
      const signal = exec.signal ?? new AbortController().signal
      const target = session_id ?? session
      if (target !== session && !(await deps.sessions(agent, signal)).some(s => s.id === target)) throw new Error(`没有这个对话：${target}（只能读你自己的对话）`)
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
    presentCall: args => ({ card: 'generic', title: `读对话记录 #${String((args as { seq?: unknown } | undefined)?.seq ?? '')}`, kind: 'other' }),
  }
  return [search, read]
}
