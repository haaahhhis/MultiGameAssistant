/**
 * Reminders that earlier parts of a conversation may be out of date. dsh's
 * time-context (in the `standard` preset) already tells the model the time and
 * how long it has been since the previous message, but a model still takes
 * open questions from two days ago, or the to-dos in a compaction summary, for
 * current ones and asks about them. Before a step, two short notes are added
 * when they apply:
 *
 * - a turn starting after a long gap: earlier to-dos and states may be stale,
 *   check them with tools before asking;
 * - a conversation summary (compaction) since the last reminder: when it was
 *   written, since its "next step" reflects that time.
 *
 * The note is appended to the history, never put in the system prompt, so the
 * model provider's prompt cache keeps working; and it is not shown in the chat
 * (convert.ts shows human messages and summaries only).
 */
import { randomUUID } from 'node:crypto'

/** The message source of the reminders, also how the next one finds the last. */
export const TIME_SOURCE = 'adg-time'
/** A gap this long gets the reminder. */
export const LONG_GAP_MS = 6 * 60 * 60_000
/** How far back a step looks for the facts, so a long session costs no more than this. */
const SCAN_LIMIT = 5000

/** The slice of a dsh session event the reminder reads. */
export interface TimedEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

/** What the reminder says, from the session's events before this step. */
export interface TimeFacts {
  /** The latest message the model saw before this step (the user's, its own, a tool result, a note). */
  readonly previous?: number
  /** The newest conversation summary (compaction) since the last reminder. */
  readonly summaryAt?: number
}

const VISIBLE = new Set(['user/message', 'assistant/message', 'tool/result'])

/**
 * Read back from the newest event to the last reminder. The step's own user
 * message (and dsh's time note for it) is still on its way in, so everything
 * here came before it.
 */
export function timeFacts(count: number, eventAt: (seq: number) => TimedEvent | undefined): TimeFacts {
  let previous: number | undefined
  let summaryAt: number | undefined
  for (let seq = count - 1; seq >= 0 && seq >= count - SCAN_LIMIT; seq--) {
    const event = eventAt(seq)
    if (event === undefined) continue
    const ours = event.type === 'user/message' && sourceKind(event.data) === TIME_SOURCE
    if (VISIBLE.has(event.type)) previous ??= event.time
    if (ours) break
    if (event.type === 'compaction/summary') summaryAt ??= event.time
  }
  return { ...(previous === undefined ? {} : { previous }), ...(summaryAt === undefined ? {} : { summaryAt }) }
}

/** The reminder for this step, or undefined when none applies. */
export function timeNote(facts: TimeFacts, now: number, step: number, timeZone: string): string | undefined {
  const lines: string[] = []
  // At a turn's start the gap is how long the user was away; later in a turn it is only the step's own work.
  if (step === 1 && facts.previous !== undefined && now - facts.previous >= LONG_GAP_MS) {
    lines.push(`（提醒）距上一条消息过去了 ${formatGap(now - facts.previous)}（上一条在 ${formatTime(facts.previous, timeZone)}，现在 ${formatTime(now, timeZone)}）。之前对话里的待办、问题和状态可能已经过时：涉及它们时先用工具查现在的情况，不要直接追问；还需要问时说明是哪天的事。`)
  }
  if (facts.summaryAt !== undefined) {
    lines.push(`（提醒）前面的对话摘要生成于 ${formatTime(facts.summaryAt, timeZone)}，只反映那时的情况，里面的待办和下一步以现在的实际状态为准。`)
  }
  return lines.length === 0 ? undefined : lines.join('\n')
}

/** `2026-10-29 周四 08:30`. */
export function formatTime(at: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(at).map(p => [p.type, p.value]))
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['weekday']} ${parts['hour']}:${parts['minute']}`
}

/** `2 天 3 小时`, `45 分钟`, `不到 1 分钟`. */
export function formatGap(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
  return `${rest} 分钟`
}

/** A user-role message as dsh's createUserMessage makes it. */
export function timeMessage(text: string): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: TIME_SOURCE, form: 'snapshot', sections: Object.freeze([Object.freeze({ name: TIME_SOURCE, text })]) }),
  })
}

function sourceKind(data: unknown): string | undefined {
  const source = typeof data === 'object' && data !== null ? (data as { source?: { kind?: unknown } }).source : undefined
  return typeof source?.kind === 'string' ? source.kind : undefined
}
