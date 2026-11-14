/**
 * @adg/gateway/low-context — low-context mode (设置 → 对话压缩): the last 12
 * hours of a conversation stay word for word; what is older is compacted into
 * the summary. It is dsh's own compaction (the summary the model writes,
 * citing what it replaced), only on a span chosen by age instead of by how
 * full the context is: nothing leaves the agent's context without being
 * compacted, and the durable log keeps every word (the chat shows it all; the
 * agent reads it back with history_search / history_read, history.ts).
 *
 * The summary itself is asked for in this app's words (`summarizeSpan`): in
 * the conversation's own language, only the parts that have something in
 * them, and about as long as what it condenses calls for. dsh's own step asks
 * for eight fixed sections in English whatever was said, so Chinese searches
 * missed its summaries and a quiet day's ran longer than the day. Only the
 * compactions this plugin starts use it; dsh's own (as the context fills up
 * mid-task, or /compact) keep dsh's checkpoint for resuming work in progress.
 *
 * It compacts only once the agent's task is over: as its turn ends, with
 * nothing of that task still going (no sub-agent working, no hand-off waiting
 * for an answer, no message queued for the next turn). Never in the middle of
 * a task, where rewriting the history would lose the model provider's prompt
 * cache on every request after it. A span too small to condense
 * (`MIN_SPAN_TOKENS`) waits for more to join it, and one dsh refused for
 * not shrinking is not tried again until it changes.
 *
 * Archiving (`archiveDays` in compaction.json): each stretch that ages out is
 * summarized on its own (a day or so of conversation at a time) instead of
 * being folded into the one summary again and again, so no summary is a
 * summary of summaries. Once the conversation a summary stands for is older
 * than that many days, the summary leaves the context too: the run of old
 * summaries at the start is replaced by one short pointer (marked
 * `ARCHIVE_MARK`), and their words go to `summaries.jsonl` beside
 * compaction.json, where history_search finds them. What was done stays in
 * the journal of long-term memory, which points back to the conversation.
 * The pointer goes in through the same compaction (its summary step answered
 * with the pointer instead of a model call), so the log records what it
 * replaced like any other summary.
 *
 * Mounted in the agent preset's compaction group, next to dsh-compaction-basic
 * (scripts/lib/standard-preset.mjs), so it reaches that group's engine. It
 * reads compaction.json each time (a stat, and the file only when it
 * changed), so turning it on or off applies at once.
 */
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, FinishReason, GenerateOptions, LlmFailure, Message, RequestMessage, StreamChunk, TextBlock, TokenUsage, ToolCallBlock, ToolHistory, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ARCHIVE_MARK, LOW_CONTEXT_WINDOW_MS, MAX_ARCHIVE_DAYS, MIN_ARCHIVE_DAYS } from '@adg/protocol'

export const name = 'adg-low-context'
export const inject = ['compaction']

export interface Config {
  /** compaction.json in the app's data. */
  readonly file?: string
}

/** Where archived summaries are kept, beside compaction.json. */
export const SUMMARIES_FILE = 'summaries.jsonl'

/** With archiving, an aged stretch waits until its oldest message is this much past the window, so a summary holds about a day. */
export const ARCHIVE_BATCH_MS = 12 * 60 * 60_000

/**
 * A span smaller than this (in the tokens dsh prices it at) stays word for
 * word until more joins it, because condensing it costs more than it saves.
 *
 * The summary call replays the system prompt, the tools and the span, so the
 * provider's cache is reused. In a real run with DeepSeek, each call read
 * about 20,000 tokens (the system prompt and tools are about 14,000 of them)
 * and wrote up to 800, reasoning included. What it saves is the span less its
 * summary, on each later request until the summary is archived.
 *
 * At 4000 that pays back within about ten requests. At 500, compacting every
 * quiet day, a six-day run used 72% more tokens than with dsh's own step at
 * 2000. Below a few hundred tokens dsh refuses the summary anyway, as it is
 * not smaller than what it replaces.
 */
export const MIN_SPAN_TOKENS = 4000

const DAY_MS = 24 * 60 * 60_000

/** The slice of a dsh session event this reads. */
export interface SurfaceEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
  /** What a replacement (a summary) stands for: the records it replaced, and its compaction's own. */
  readonly sourceEventSeqs?: readonly number[]
}

/** The slice of a dsh session this reads. */
export interface SurfaceView {
  readonly surface: { readonly nodes: readonly number[] }
  eventAt(seq: number): SurfaceEvent | undefined
}

const isReplace = (event: SurfaceEvent) => typeof event.surfaceOp === 'object' && event.surfaceOp !== null
const sourceOf = (data: unknown): { kind?: unknown; form?: unknown } => (data as { source?: { kind?: unknown; form?: unknown } } | undefined)?.source ?? {}

/** A summary, or an archive pointer, in place of earlier history (a pruned tool result is a replacement too, but not one of these). */
export const isSummaryNode = (event: SurfaceEvent): boolean => event.type === 'user/message' && isReplace(event)

/** The words of a message event. */
export function eventText(event: SurfaceEvent): string {
  const content = (event.data as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content.map(block => ((block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : '')).join('\n')
}

/** The pointer archiving leaves in place of old summaries. */
export const isPointer = (event: SurfaceEvent): boolean => isSummaryNode(event) && eventText(event).includes(ARCHIVE_MARK)

/** A summary's own words, without dsh's framing around them. */
export function summaryText(event: SurfaceEvent): string {
  const text = eventText(event)
  const open = '<compacted-summary>'
  const at = text.indexOf(open)
  const end = text.lastIndexOf('</compacted-summary>')
  return (at >= 0 && end > at ? text.slice(at + open.length, end) : text).trim()
}

/** What a person typed (in the app, or through the API: Feishu, QQ). */
const TYPED = new Set(['user', 'user-rpc'])
/** What the app or another agent sent: a notice (a result handed back, an alert) or a relayed message. */
const SENT = new Set(['notice', 'relay'])

/**
 * A message of the conversation: what the user said, or what the app or another
 * agent sent. Not a summary (it replaced earlier ones), and not the context the
 * harness adds to a turn (runtime context, the skill catalog, the time and
 * reminders: forms instructions, catalog, recall, snapshot).
 */
export function isMessage(event: SurfaceEvent): boolean {
  if (event.type !== 'user/message' || isReplace(event)) return false
  const { kind, form } = sourceOf(event.data)
  return TYPED.has(String(kind)) || SENT.has(String(form))
}

/**
 * The span to compact, as the inclusive first and last surface seqs; null when
 * nothing needs it: everything from after the system prompt up to the first
 * message of the window. It ends just before a message, so a turn (with its
 * tool calls and results) goes whole, and the latest message always stays.
 *
 * `separate` (archiving): the summaries at the start stay as they are and only
 * what follows them is compacted, into a summary of its own; and only once its
 * oldest message is `batchMs` past the window, so one summary holds a good stretch.
 */
export function lowContextRange(session: SurfaceView, options: { now: number; windowMs?: number; separate?: boolean; batchMs?: number }): { start: number; end: number } | null {
  const nodes = session.surface.nodes
  const events = nodes.map(seq => session.eventAt(seq))
  let first = events[0]?.type === 'system/message' ? 1 : 0
  if (options.separate === true) while (first < events.length && events[first] !== undefined && isSummaryNode(events[first]!)) first++
  const messages: number[] = []
  for (let i = first; i < events.length; i++) if (events[i] !== undefined && isMessage(events[i]!)) messages.push(i)
  if (messages.length === 0) return null
  const cutoff = options.now - (options.windowMs ?? LOW_CONTEXT_WINDOW_MS)
  // The first message in the window; when every one is older, the latest of them stays.
  const keepFrom = messages.find(i => events[i]!.time >= cutoff) ?? messages[messages.length - 1]!
  if (keepFrom <= first) return null
  // Only a summary before it: nothing new to compact.
  if (events.slice(first, keepFrom).every(event => event === undefined || isReplace(event) || event.type === 'system/message')) return null
  if (options.separate === true && events[messages[0]!]!.time >= cutoff - (options.batchMs ?? 0)) return null
  return { start: nodes[first]!, end: nodes[keepFrom - 1]! }
}

/** What a summary stands for: the time and the numbers (#seq) of the first and last messages it replaced. */
export interface Cover {
  readonly from: number
  readonly to: number
  readonly firstSeq: number
  readonly lastSeq: number
}

/** What a model step and a turn are made of: what a summary's time span counts (not its compaction's own records). */
const SPOKEN = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/** The slice of dsh's token meter (the `tokenMeter` service) this reads: what each surface node costs. */
export interface TokenMeter {
  measure(session: unknown): { readonly nodes: readonly { readonly seq: number; readonly tokens: number }[] }
}

/** What dsh prices a span at when deciding whether its summary is smaller (the tokens of its surface nodes); undefined when the meter cannot tell. */
export function spanTokens(meter: TokenMeter | undefined, session: unknown, range: { start: number; end: number }): number | undefined {
  if (typeof meter?.measure !== 'function') return undefined
  try {
    const nodes = meter.measure(session).nodes
    const from = nodes.findIndex(node => node.seq === range.start)
    const to = nodes.findIndex(node => node.seq === range.end)
    if (from < 0 || to < from) return undefined
    return nodes.slice(from, to + 1).reduce((sum, node) => sum + node.tokens, 0)
  } catch {
    return undefined
  }
}

/** dsh refused the summary for not being smaller than what it would replace (the same span will be refused again). */
export function refusedForSize(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 5; at = (at as { cause?: unknown }).cause, depth++) {
    if (at instanceof Error && /not smaller than the shadowed/.test(at.message)) return true
  }
  return false
}

/** Spans dsh refused, per conversation and kind of compaction, so the same span is not summarized again for nothing. */
export class Refusals {
  readonly #spans = new Map<string, string>()
  #key = (sessionId: string, kind: string) => `${kind}:${sessionId}`
  has(sessionId: string, kind: string, range: { start: number; end: number }): boolean {
    return this.#spans.get(this.#key(sessionId, kind)) === `${range.start}-${range.end}`
  }
  add(sessionId: string, kind: string, range: { start: number; end: number }): void {
    const key = this.#key(sessionId, kind)
    this.#spans.delete(key)
    this.#spans.set(key, `${range.start}-${range.end}`)
    while (this.#spans.size > 1000) this.#spans.delete(this.#spans.keys().next().value!)
  }
}

/** The span a summary (or a pointer) replaced; a summary inside it counts for what that one replaced in turn. */
export function coverOf(session: SurfaceView, event: SurfaceEvent, depth = 0): Cover | undefined {
  let cover: Cover | undefined
  for (const seq of event.sourceEventSeqs ?? []) {
    const source = session.eventAt(seq)
    if (source === undefined) continue
    const next = isSummaryNode(source)
      ? (depth < 8 ? coverOf(session, source, depth + 1) : undefined)
      : SPOKEN.has(source.type) && !isReplace(source) ? { from: source.time, to: source.time, firstSeq: seq, lastSeq: seq } : undefined
    if (next === undefined) continue
    cover = cover === undefined ? next : { from: Math.min(cover.from, next.from), to: Math.max(cover.to, next.to), firstSeq: Math.min(cover.firstSeq, next.firstSeq), lastSeq: Math.max(cover.lastSeq, next.lastSeq) }
  }
  return cover
}

/** The old summaries to archive. */
export interface ArchiveRange {
  /** The inclusive first and last surface seqs: the summaries, and an earlier pointer among them. */
  readonly start: number
  readonly end: number
  /** All they stand for, together. */
  readonly cover: Cover
  /** The summaries' own words, to keep where history_search finds them. */
  readonly summaries: readonly { readonly seq: number; readonly text: string; readonly cover: Cover }[]
}

/**
 * The run of summaries at the start of the context (an earlier pointer
 * included) whose conversation ended more than `archiveDays` ago; null when
 * none has, or there is only a pointer.
 */
export function archiveRange(session: SurfaceView, options: { now: number; archiveDays: number }): ArchiveRange | null {
  const nodes = session.surface.nodes
  const events = nodes.map(seq => session.eventAt(seq))
  const first = events[0]?.type === 'system/message' ? 1 : 0
  const cutoff = options.now - options.archiveDays * DAY_MS
  const taken: { at: number; cover: Cover }[] = []
  for (let i = first; i < events.length; i++) {
    const event = events[i]
    if (event === undefined || !isSummaryNode(event)) break
    const cover = coverOf(session, event)
    // What it stands for cannot be told, or is not old yet: it stays, and so does everything after it.
    if (cover === undefined || cover.to >= cutoff) break
    taken.push({ at: i, cover })
  }
  const summaries = taken.filter(({ at }) => !isPointer(events[at]!))
  if (summaries.length === 0) return null
  const cover = taken.slice(1).reduce((all, { cover: next }) => ({ from: Math.min(all.from, next.from), to: Math.max(all.to, next.to), firstSeq: Math.min(all.firstSeq, next.firstSeq), lastSeq: Math.max(all.lastSeq, next.lastSeq) }), taken[0]!.cover)
  return {
    start: nodes[taken[0]!.at]!,
    end: nodes[taken.at(-1)!.at]!,
    cover,
    summaries: summaries.map(({ at, cover: own }) => ({ seq: nodes[at]!, text: summaryText(events[at]!), cover: own })),
  }
}

/** `2026-11-01 08:30`, in this machine's time zone (the user's). */
function clock(time: number): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(time)).map(p => [p.type, p.value]))
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}`
}

/** What stands in the context for archived conversation: where it went, and how to find it again. */
export function pointerText(cover: Cover): string {
  const from = clock(cover.from)
  const to = clock(cover.to)
  return `${ARCHIVE_MARK}这个对话 ${from === to ? from : `${from} 到 ${to}`} 的内容（原文 #${cover.firstSeq}–#${cover.lastSeq}）已经移出上下文，它的摘要也已归档。那段时间做过、定过的事记在长期记忆的日记里（标着「可查原文」的能用 history_read 的 memory_id 读当时的对话）；需要细节时用 history_search 查（能搜到归档的摘要和原话），或用 history_read 按 #编号读原文。不要凭印象猜那段时间说过什么。`
}

/** One archived summary, as summaries.jsonl keeps it. */
export interface ArchivedSummary {
  readonly sessionId: string
  /** The summary's own number in the conversation (history_read opens it). */
  readonly seq: number
  readonly from: number
  readonly to: number
  readonly firstSeq: number
  readonly lastSeq: number
  readonly text: string
  readonly archivedAt: number
}

/** Keep summaries before they leave the context. Written before the pointer goes in, so a failed compaction leaves at most a copy kept twice. */
export async function keepSummaries(file: string, sessionId: string, summaries: ArchiveRange['summaries'], now = Date.now()): Promise<void> {
  if (summaries.length === 0) return
  await mkdir(dirname(file), { recursive: true })
  const rows = summaries.map(s => JSON.stringify({ sessionId, seq: s.seq, ...s.cover, text: s.text, archivedAt: now } satisfies ArchivedSummary))
  await appendFile(file, `${rows.join('\n')}\n`, 'utf8')
}

/** The archived summaries, one per summary (a copy kept twice counts once); read again only when the file changed. */
export function summariesReader(file: string | undefined): () => Promise<readonly ArchivedSummary[]> {
  let stamp = ''
  let rows: readonly ArchivedSummary[] = []
  return async () => {
    if (file === undefined) return []
    try {
      const info = await stat(file)
      const now = `${info.mtimeMs}:${info.size}`
      if (now === stamp) return rows
      const byKey = new Map<string, ArchivedSummary>()
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (line.trim() === '') continue
        try {
          const row = JSON.parse(line) as ArchivedSummary
          if (typeof row.sessionId === 'string' && Number.isInteger(row.seq) && typeof row.text === 'string') byKey.set(`${row.sessionId}#${row.seq}`, row)
        } catch {
          // a line cut short: the rest still count
        }
      }
      stamp = now
      rows = [...byKey.values()]
    } catch {
      stamp = ''
      rows = []
    }
    return rows
  }
}

/** compaction.json's low-context switch; off when missing or broken. */
export function parseLowContext(raw: unknown): boolean {
  return (raw as { lowContext?: unknown } | undefined)?.lowContext === true
}

/** compaction.json's archiving: a number of days, or null (off) when missing or out of range. */
export function parseArchiveDays(raw: unknown): number | null {
  const days = (raw as { archiveDays?: unknown } | undefined)?.archiveDays
  return typeof days === 'number' && Number.isInteger(days) && days >= MIN_ARCHIVE_DAYS && days <= MAX_ARCHIVE_DAYS ? days : null
}

export interface LowContextSettings {
  readonly lowContext: boolean
  readonly archiveDays: number | null
}

const OFF: LowContextSettings = { lowContext: false, archiveDays: null }

/** Reads the file again only when it changed. */
export function settingsReader(file: string | undefined): () => LowContextSettings {
  let stamp = ''
  let settings = OFF
  return () => {
    if (file === undefined) return settings
    try {
      const info = statSync(file)
      const now = `${info.mtimeMs}:${info.size}`
      if (now !== stamp) {
        stamp = now
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        settings = { lowContext: parseLowContext(raw), archiveDays: parseArchiveDays(raw) }
      }
    } catch {
      stamp = ''
      settings = OFF
    }
    return settings
  }
}

/** The agent ending its turn, as dsh's `agent/turn-stopping` gives it. */
export interface StoppingAgent {
  readonly session: SurfaceView & { readonly id: string; requestHeader?(): { readonly config?: { readonly provider?: string; readonly model?: string } } | undefined }
  readonly inbox?: { readonly nextTurn?: readonly unknown[]; readonly nextStep?: readonly unknown[] }
}

/** What dsh's compaction hands its summarize step: the system prompt and the span as the model last saw them, and the tools it had. */
export interface SummarizationInput {
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

/** What dsh's compaction expects back from its summarize step (dsh-compaction-basic's `SummaryResult`). */
export interface SummaryResult {
  readonly summary: TextBlock[]
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly usage?: TokenUsage
  /** Everything the model answered, reasoning included, as dsh records it beside the summary. */
  readonly rawOutput?: ContentBlock[]
  /** The summary came from one call through dsh's llm service. */
  readonly llmStreamCall?: true
}

/** The agent whose span is summarized, as the summarize step reads it (dsh's own Agent). */
export interface SummarizingAgent {
  readonly session: {
    readonly id: string
    requestHeader?(): { readonly config?: { readonly provider?: string; readonly model?: string } } | undefined
    toolHistory?(): ToolHistory
  }
  readonly options?: { readonly provider?: string; readonly model?: string }
}

/** Answers the engine's summarize step. */
export type SummaryStep = (input: SummarizationInput, agent: SummarizingAgent, signal?: AbortSignal) => Promise<SummaryResult>

interface Engine {
  compactRegion?(start: number, end: number, agent: unknown, signal: AbortSignal): Promise<{ shadowedSeqs: readonly number[] }>
  summarize?(input: unknown, agent: unknown, signal?: AbortSignal): Promise<unknown>
  /** dsh-compaction-basic's resolved config: which model summarizes, and its output cap. */
  readonly config?: SummaryPolicy
}

/** Runs the engine's compaction of a span with this plugin's own summarize step. */
export interface OwnSummaries {
  run(range: { start: number; end: number }, agent: StoppingAgent, step: SummaryStep, signal: AbortSignal): Promise<{ shadowedSeqs: readonly number[] }>
  dispose(): void
}

/**
 * dsh's compaction asks its `summarize` step for the words that replace a
 * span. While this plugin compacts a session, that step is the plugin's: a
 * summary written for this app, or the archive pointer with no model call at
 * all. Every other compaction of the engine (dsh's own, as the context fills
 * up mid-task, or /compact) keeps dsh's step and its template. Undefined when
 * the engine has no such step.
 */
export function ownSummaries(engine: Engine): OwnSummaries | undefined {
  const original = engine.summarize
  if (typeof original !== 'function' || typeof engine.compactRegion !== 'function') return undefined
  const steps = new Map<string, SummaryStep>()
  const ours = function (this: unknown, input: unknown, agent: unknown, signal?: AbortSignal): Promise<unknown> {
    const session = (agent as SummarizingAgent | undefined)?.session
    const step = session === undefined ? undefined : steps.get(session.id)
    return step === undefined ? original.call(this, input, agent, signal) : step(input as SummarizationInput, agent as SummarizingAgent, signal)
  }
  engine.summarize = ours
  return {
    async run(range, agent, step, signal) {
      steps.set(agent.session.id, step)
      try {
        return await engine.compactRegion!(range.start, range.end, agent, signal)
      } finally {
        steps.delete(agent.session.id)
      }
    },
    dispose() {
      if (engine.summarize !== ours) return
      // The engine's own step is its class's: removing ours brings it back; one set on the engine itself is put back.
      delete engine.summarize
      if (engine.summarize !== original) engine.summarize = original
    },
  }
}

/** The archive pointer, as the summary of the summaries it replaces: no model call. */
export function pointerStep(text: string): SummaryStep {
  return async (_input, agent) => {
    const route = agent.session.requestHeader?.()?.config
    return { summary: [{ type: 'text', text }], provider: route?.provider ?? 'adg', model: route?.model ?? 'archive' }
  }
}

/** The slice of dsh-compaction-basic's resolved config the summary call follows, as dsh's own step does. */
export interface SummaryPolicy {
  readonly summarizationProvider?: string
  readonly summarizationModel?: string
  readonly maxTokens?: number
  readonly modelPolicies?: readonly { readonly provider: string; readonly model: string; readonly summarizationProvider?: string; readonly summarizationModel?: string; readonly maxTokens?: number }[]
}

/**
 * The model that summarizes, and its output cap, chosen as dsh's own step
 * chooses them: a summarizer set in the compaction config (for this
 * conversation's model, or for all), else the model the conversation last
 * used, else the agent's own.
 */
export function summaryTarget(policy: SummaryPolicy | undefined, agent: SummarizingAgent): { provider: string; model: string; maxTokens?: number } {
  const both = (route: { readonly provider?: string | undefined; readonly model?: string | undefined } | undefined) =>
    route?.provider !== undefined && route.provider !== '' && route.model !== undefined && route.model !== '' ? { provider: route.provider, model: route.model } : undefined
  const routed = both(agent.session.requestHeader?.()?.config)
  const own = both(agent.options)
  const conversation = routed ?? own
  const override = conversation === undefined ? undefined : policy?.modelPolicies?.find(p => p.provider === conversation.provider && p.model === conversation.model)
  const configured = both({ provider: override?.summarizationProvider ?? policy?.summarizationProvider, model: override?.summarizationModel ?? policy?.summarizationModel })
  const target = configured ?? conversation
  if (target === undefined) throw new Error('no provider/model to summarize with: no request routed yet, and the agent names none')
  const maxTokens = override?.maxTokens ?? policy?.maxTokens
  return { ...target, ...(maxTokens === undefined ? {} : { maxTokens }) }
}

/**
 * How much a span says: the characters of what was said in it (by the user,
 * the app or another agent, and the agent's replies), its tool calls and
 * results, and an earlier summary in it. Not the system prompt, the harness's
 * notes on each turn (runtime context, the time, recall), or the model's
 * reasoning: a summary has no use for them.
 */
export function spanChars(input: SummarizationInput): number {
  let chars = 0
  for (const message of input.messages) {
    if (message.role === 'system' || message.role === 'developer') continue
    if (message.role === 'user') {
      const { kind, form } = sourceOf({ source: message.source })
      if (!TYPED.has(String(kind)) && !SENT.has(String(form)) && kind !== 'compact-checkpoint') continue
    }
    for (const block of message.content) {
      if (block.type === 'text') chars += block.text.length
      else if (block.type === 'tool-call') chars += block.name.length + block.arguments.length
    }
  }
  return chars
}

/** The most a summary should run to, in characters: about a fifth of what it condenses, from 150 to 2000. */
export function summaryBudget(chars: number): number {
  return Math.min(2000, Math.max(150, Math.round(chars / 5 / 50) * 50))
}

/**
 * What low-context mode asks of the model, as the last message after the span
 * (the place dsh's own instruction takes, so the provider's prompt cache of
 * the span is still used). dsh's asks for eight fixed sections in English
 * whatever was said; this one asks for the conversation's own language, at a
 * length that follows what happened.
 */
export function summaryInstruction(budget: number): string {
  return [
    '请把上面这段对话压缩成一份摘要。摘要会替换掉上面的原文留在上下文里：之后接着对话时你只看得到它，所以要凭它就能接着做下去。',
    '',
    '要求：',
    '- 用这段对话本身的语言写：对话主要是中文就写中文，主要是别的语言就用那种语言。',
    `- 篇幅跟着内容走，最多约 ${budget} 字。只聊了几句就只写几行；宁短勿长，不要凑字数。`,
    '- 用简短的条目，不写成段落。只写对话里确实有的内容，不推测，不补充。',
    '- 按下面几类整理，每类用一行「### 类名」开头。没有内容的类整个省掉，不要写「无」；总共只有几条时不必分类。',
    '  - 用户要做什么：目标和请求，以及后来的改动；措辞要紧的地方引用原话',
    '  - 做了什么、结果如何：完成的事、得到的结论、遇到的问题和怎么解决的',
    '  - 定下的事：做出的决定和理由，用户的偏好、要求和纠正',
    '  - 还没做完的：答应了或被要求了但还没完成的事，等着回答的问题',
    '  - 要记住的细节：之后会用到的名称、数字、时间、路径、命令、账号、游戏里的数据',
    '- 名称、数字、文件路径、命令、报错原文、标识符一字不改地保留，不要翻译、换算，也不要概括成「若干」「一些」。',
    '- 提到时间写出具体日期，不要写「今天」「昨天」：这份摘要会在之后好几天里被读到。',
    `- 上面如果已经有 <compacted-summary> 包着的旧摘要，把它和之后的内容合成一份：仍然成立的保留，过时的去掉，不要整段照抄。旧摘要里以「${ARCHIVE_MARK}」开头的归档说明原样保留在最前面。`,
    '- 不要提这次压缩或这条要求，不要调用任何工具，只输出摘要正文。',
  ].join('\n')
}

/** A summary call that did not end well, with the llm's own code (`MAX_TOKENS` for one cut off at the cap). */
export class SummaryError extends Error {
  readonly code: string
  readonly failure: LlmFailure | undefined
  constructor(message: string, code: string, failure?: LlmFailure) {
    super(message)
    this.name = 'SummaryError'
    this.code = code
    this.failure = failure
  }
}

/**
 * A streamed answer put together from dsh's llm chunks, as dsh's
 * BlockAssembler does it: blocks in the order they began, each from its
 * `block-end` when one came, else from its deltas.
 */
export async function assemble(stream: AsyncIterable<StreamChunk>): Promise<{ blocks: ContentBlock[]; usage?: TokenUsage; finish: FinishReason }> {
  const order: number[] = []
  const parts = new Map<number, { type: string; text: string; id?: ToolCallBlock['id']; name?: string; block?: ContentBlock }>()
  const part = (index: number, type: string) => {
    let found = parts.get(index)
    if (found === undefined) {
      found = { type, text: '' }
      parts.set(index, found)
      order.push(index)
    }
    return found
  }
  let usage: TokenUsage | undefined
  let finish: FinishReason = { kind: 'stop' }
  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'block-start':
        part(chunk.index, chunk.blockType)
        break
      case 'text-delta':
      case 'reasoning-delta': {
        const at = part(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (at.block === undefined) at.text += chunk.text
        break
      }
      case 'tool-call-delta': {
        const at = part(chunk.index, 'tool-call')
        if (at.block !== undefined) break
        at.id = chunk.id
        if (chunk.name !== undefined && chunk.name !== '') at.name = chunk.name
        at.text += chunk.argumentsDelta
        break
      }
      case 'block-end': {
        const at = part(chunk.index, chunk.block.type)
        if (at.block === undefined) at.block = chunk.block
        break
      }
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finish = chunk.reason
        break
    }
  }
  const blocks = order.flatMap((index): ContentBlock[] => {
    const at = parts.get(index)!
    if (at.block !== undefined) return [at.block]
    if (at.type === 'text' || at.type === 'reasoning') return [{ type: at.type, text: at.text }]
    if (at.type === 'tool-call' && at.id !== undefined) return [{ type: 'tool-call', id: at.id, name: at.name ?? '', arguments: at.text }]
    return []
  })
  return { blocks, ...(usage === undefined ? {} : { usage }), finish }
}

/** The slice of dsh's llm service the summary call uses. */
export interface Llm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * The summarize step of low-context mode: the call dsh's own step makes (the
 * system prompt, tools and span replayed as they were, so the provider's
 * prompt cache is reused, then one more user message), with the instruction
 * of `summaryInstruction` as that message. Fails as dsh's does: on an error
 * from the llm, an answer cut off at the cap, or no words at all.
 */
export async function summarizeSpan(llm: Llm, policy: SummaryPolicy | undefined, input: SummarizationInput, agent: SummarizingAgent, signal?: AbortSignal): Promise<SummaryResult> {
  const target = summaryTarget(policy, agent)
  const instruction: RequestMessage = { role: 'user', content: [{ type: 'text', text: summaryInstruction(summaryBudget(spanChars(input))) }] }
  const toolHistory = agent.session.toolHistory?.()
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages: [...input.messages, instruction],
    ...(toolHistory === undefined ? {} : { toolHistory }),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    ...(target.maxTokens === undefined ? {} : { maxTokens: target.maxTokens }),
    sessionId: agent.session.id as NonNullable<GenerateOptions['sessionId']>,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  const answer = await assemble(llm.stream(options))
  switch (answer.finish.kind) {
    case 'error':
    case 'aborted':
      throw new SummaryError(answer.finish.failure.message, answer.finish.failure.code, answer.finish.failure)
    case 'max-tokens':
      throw new SummaryError('summarization truncated at the token cap (incomplete checkpoint)', 'MAX_TOKENS')
  }
  if (answer.blocks.some(block => block.type === 'image')) throw new SummaryError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  const summary = answer.blocks.filter((block): block is TextBlock => block.type === 'text')
  if (!summary.some(block => block.text.trim() !== '')) throw new SummaryError('summarization produced no text summary content', 'EMPTY_SUMMARY')
  return {
    summary,
    rawOutput: answer.blocks,
    llmStreamCall: true,
    provider: target.provider,
    model: target.model,
    ...(target.maxTokens === undefined ? {} : { maxTokens: target.maxTokens }),
    ...(answer.usage === undefined ? {} : { usage: answer.usage }),
  }
}

/** The gateway's view of work still going for a conversation (index.ts `workPending`). */
interface WorkView {
  workPending?(sessionId: string): boolean
}

/**
 * Is the agent's task over as its turn ends? Not when a message waits for its
 * next turn, a sub-agent of it is working, or a colleague still owes it an
 * answer: those bring it back to the same task.
 */
export function taskOver(agent: StoppingAgent, work: WorkView | undefined): boolean {
  if ((agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0) return false
  return work?.workPending?.(agent.session.id) !== true
}

export function apply(ctx: Context, config: Config = {}): void {
  const log = ctx.logger('adg-low-context')
  const settings = settingsReader(config.file)
  const engine = (ctx as unknown as { compaction: Engine }).compaction
  if (typeof engine?.compactRegion !== 'function') {
    log.warn('this dsh compaction has no compactRegion: low-context mode is off')
    return
  }
  const own = ownSummaries(engine)
  if (own === undefined) log.warn("this dsh compaction has no summarize step: its own summaries stand, and archiving is off")
  else (ctx as unknown as { effect(run: () => () => void, label: string): void }).effect(() => () => own.dispose(), 'adg-low-context summaries')
  const summariesFile = config.file === undefined ? undefined : join(dirname(config.file), SUMMARIES_FILE)
  const refused = new Refusals()
  const service = <T>(name: string): T | undefined => {
    try {
      return (ctx.get as (name: string) => unknown)(name) as T | undefined
    } catch {
      return undefined
    }
  }
  // dsh's own meter, which its compaction prices spans with; optional: without it every span is tried.
  const meter = () => service<TokenMeter>('tokenMeter')
  // The summary of a span: the app's own (summarizeSpan) through dsh's llm service; without that service, dsh's.
  const compact = (range: { start: number; end: number }, agent: StoppingAgent, signal: AbortSignal) => {
    const llm = service<Llm>('llm')
    if (own === undefined || typeof llm?.stream !== 'function') return engine.compactRegion!(range.start, range.end, agent, signal)
    return own.run(range, agent, (input, owner, abort) => summarizeSpan(llm, engine.config, input, owner, abort), signal)
  }

  // The turn is still open here, so the compaction belongs to it (as dsh's own automatic one does).
  ctx.on('agent/turn-stopping' as never, (async ({ agent, signal }: { agent: StoppingAgent; signal: AbortSignal }) => {
    const { lowContext, archiveDays } = settings()
    if (!lowContext || signal.aborted) return
    const archiving = archiveDays !== null && own !== undefined && summariesFile !== undefined
    try {
      if (!taskOver(agent, (ctx.get as (name: string) => unknown)('adgGateway') as WorkView | undefined)) return
    } catch (error) {
      log.warn(`low-context: could not tell whether the task of ${agent.session.id} is over: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const sessionId = agent.session.id
    // A span dsh refused for size is not tried again until it changes.
    const remember = (kind: string, range: { start: number; end: number }) => (error: unknown): never => {
      if (refusedForSize(error)) refused.add(sessionId, kind, range)
      throw error
    }
    try {
      const range = lowContextRange(agent.session, { now: Date.now(), ...(archiving ? { separate: true, batchMs: ARCHIVE_BATCH_MS } : {}) })
      const tokens = range === null ? undefined : spanTokens(meter(), agent.session, range)
      if (range !== null && (tokens === undefined || tokens >= MIN_SPAN_TOKENS) && !refused.has(sessionId, 'compact', range)) {
        const result = await compact(range, agent, signal).catch(remember('compact', range))
        log.info(`low-context: compacted ${result.shadowedSeqs.length} records (seqs ${range.start}-${range.end}, ${tokens ?? '?'} tokens) of ${sessionId}`)
      }
    } catch (error) {
      log.warn(`low-context compaction of ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!archiving || signal.aborted) return
    try {
      const old = archiveRange(agent.session, { now: Date.now(), archiveDays })
      if (old === null || refused.has(sessionId, 'archive', old)) return
      await keepSummaries(summariesFile, sessionId, old.summaries)
      const result = await own.run(old, agent, pointerStep(pointerText(old.cover)), signal).catch(remember('archive', old))
      log.info(`low-context: archived ${old.summaries.length} summaries (${result.shadowedSeqs.length} records, seqs ${old.start}-${old.end}) of ${sessionId}`)
    } catch (error) {
      log.warn(`low-context archiving of ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)
}
