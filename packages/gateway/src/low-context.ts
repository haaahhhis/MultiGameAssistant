/**
 * @adg/gateway/low-context — low-context mode (设置 → 对话压缩): the last 12
 * hours of a conversation stay word for word; what is older is compacted into
 * the summary. It is dsh's own compaction (the summary the model writes,
 * citing what it replaced), only on a span chosen by age instead of by how
 * full the context is: nothing leaves the agent's context without being
 * compacted, and the durable log keeps every word (the chat shows it all; the
 * agent reads it back with history_search / history_read, history.ts).
 *
 * It compacts only once the agent's task is over: as its turn ends, with
 * nothing of that task still going (no sub-agent working, no hand-off waiting
 * for an answer, no message queued for the next turn). Never in the middle of
 * a task, where rewriting the history would lose the model provider's prompt
 * cache on every request after it.
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
  return `${ARCHIVE_MARK}这个对话 ${clock(cover.from)} 到 ${clock(cover.to)} 的内容（原文 #${cover.firstSeq}–#${cover.lastSeq}）已经移出上下文，它的摘要也已归档。那段时间做过、定过的事记在长期记忆的日记里（标着「可查原文」的能用 history_read 的 memory_id 读当时的对话）；需要细节时用 history_search 查（能搜到归档的摘要和原话），或用 history_read 按 #编号读原文。不要凭印象猜那段时间说过什么。`
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

interface Engine {
  compactRegion?(start: number, end: number, agent: unknown, signal: AbortSignal): Promise<{ shadowedSeqs: readonly number[] }>
  summarize?(input: unknown, agent: unknown, signal?: AbortSignal): Promise<unknown>
}

/** Puts a pointer in place of a span, through the engine's own compaction. */
export interface Archiver {
  run(range: { start: number; end: number }, agent: StoppingAgent, text: string, signal: AbortSignal): Promise<{ shadowedSeqs: readonly number[] }>
  dispose(): void
}

/**
 * dsh's compaction asks its `summarize` step for the words that replace a
 * span; while a session is being archived, that step answers with the pointer
 * instead of a model call. Every other summary is the engine's own.
 * Undefined when the engine has no such step.
 */
export function archiver(engine: Engine): Archiver | undefined {
  const original = engine.summarize
  if (typeof original !== 'function' || typeof engine.compactRegion !== 'function') return undefined
  const pointers = new Map<string, string>()
  const ours = function (this: unknown, input: unknown, agent: unknown, signal?: AbortSignal): Promise<unknown> {
    const session = (agent as StoppingAgent | undefined)?.session
    const text = session === undefined ? undefined : pointers.get(session.id)
    if (text === undefined) return original.call(this, input, agent, signal)
    const route = session!.requestHeader?.()?.config
    return Promise.resolve({ summary: [{ type: 'text', text }], provider: route?.provider ?? 'adg', model: route?.model ?? 'archive' })
  }
  engine.summarize = ours
  return {
    async run(range, agent, text, signal) {
      pointers.set(agent.session.id, text)
      try {
        return await engine.compactRegion!(range.start, range.end, agent, signal)
      } finally {
        pointers.delete(agent.session.id)
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
  const archive = archiver(engine)
  if (archive === undefined) log.warn('this dsh compaction has no summarize step: archiving is off')
  else (ctx as unknown as { effect(run: () => () => void, label: string): void }).effect(() => () => archive.dispose(), 'adg-low-context archiving')
  const summariesFile = config.file === undefined ? undefined : join(dirname(config.file), SUMMARIES_FILE)

  // The turn is still open here, so the compaction belongs to it (as dsh's own automatic one does).
  ctx.on('agent/turn-stopping' as never, (async ({ agent, signal }: { agent: StoppingAgent; signal: AbortSignal }) => {
    const { lowContext, archiveDays } = settings()
    if (!lowContext || signal.aborted) return
    const archiving = archiveDays !== null && archive !== undefined && summariesFile !== undefined
    try {
      if (!taskOver(agent, (ctx.get as (name: string) => unknown)('adgGateway') as WorkView | undefined)) return
    } catch (error) {
      log.warn(`low-context: could not tell whether the task of ${agent.session.id} is over: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    try {
      const range = lowContextRange(agent.session, { now: Date.now(), ...(archiving ? { separate: true, batchMs: ARCHIVE_BATCH_MS } : {}) })
      if (range !== null) {
        const result = await engine.compactRegion!(range.start, range.end, agent, signal)
        log.info(`low-context: compacted ${result.shadowedSeqs.length} records (seqs ${range.start}-${range.end}) of ${agent.session.id}`)
      }
    } catch (error) {
      log.warn(`low-context compaction of ${agent.session.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!archiving || signal.aborted) return
    try {
      const old = archiveRange(agent.session, { now: Date.now(), archiveDays })
      if (old === null) return
      await keepSummaries(summariesFile, agent.session.id, old.summaries)
      const result = await archive.run(old, agent, pointerText(old.cover), signal)
      log.info(`low-context: archived ${old.summaries.length} summaries (${result.shadowedSeqs.length} records, seqs ${old.start}-${old.end}) of ${agent.session.id}`)
    } catch (error) {
      log.warn(`low-context archiving of ${agent.session.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)
}
