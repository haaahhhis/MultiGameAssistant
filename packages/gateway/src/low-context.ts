/**
 * @adg/gateway/low-context — low-context mode (设置 → 对话压缩): before each
 * step, the conversation is compacted down to its latest few messages, and a
 * message older than a day is compacted however few there are. It is dsh's own
 * compaction (the summary the model writes, citing what it replaced), only on a
 * span chosen by message count and age instead of by how full the context is:
 * nothing leaves the agent's context without being compacted, and the durable
 * log keeps every word (the chat shows it all; the agent reads it back with
 * history_search / history_read, history.ts).
 *
 * Mounted in the agent preset's compaction group, next to dsh-compaction-basic
 * (scripts/lib/standard-preset.mjs), so it reaches that group's engine. It
 * reads compaction.json before every step (a stat, and the file only when it
 * changed), so turning it on or off applies at once.
 */
import { readFileSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_KEEP_MESSAGES, LOW_CONTEXT_MAX_AGE_MS, MAX_KEEP_MESSAGES, MIN_KEEP_MESSAGES } from '@adg/protocol'

export const name = 'adg-low-context'
export const inject = ['compaction']

export interface Config {
  /** compaction.json in the app's data. */
  readonly file?: string
}

/** The slice of a dsh session event this reads. */
export interface SurfaceEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
  readonly surfaceOp?: unknown
}

/** The slice of a dsh session this reads. */
export interface SurfaceView {
  readonly surface: { readonly nodes: readonly number[] }
  eventAt(seq: number): SurfaceEvent | undefined
}

export interface LowContextOptions {
  /** The latest messages kept word for word. */
  readonly keep: number
  readonly now: number
  /** Older than this is compacted, however few. */
  readonly maxAgeMs?: number
  /**
   * Messages past `keep` before it compacts by count, so each new message does
   * not cost a summary of its own: it keeps `keep` to `keep + slack`.
   */
  readonly slack?: number
}

/** How many messages over `keep` wait for the next compaction. */
export const SLACK = 2

const isReplace = (event: SurfaceEvent) => typeof event.surfaceOp === 'object' && event.surfaceOp !== null
const sourceOf = (data: unknown): { kind?: unknown; form?: unknown } => (data as { source?: { kind?: unknown; form?: unknown } } | undefined)?.source ?? {}

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
 * nothing needs it. It starts after the system prompt and ends just before a
 * message, so a turn (with its tool calls and results) goes whole, and the
 * latest message always stays.
 */
export function lowContextRange(session: SurfaceView, options: LowContextOptions): { start: number; end: number } | null {
  const nodes = session.surface.nodes
  const events = nodes.map(seq => session.eventAt(seq))
  const first = events[0]?.type === 'system/message' ? 1 : 0
  const messages: number[] = []
  for (let i = first; i < events.length; i++) if (events[i] !== undefined && isMessage(events[i]!)) messages.push(i)
  if (messages.length === 0) return null
  const keep = Math.max(1, options.keep)
  const slack = options.slack ?? SLACK
  let keepFrom = -1
  if (messages.length > keep + slack) keepFrom = messages[messages.length - keep]!
  // The first message within the age; when every one is older, the latest of them stays.
  const cutoff = options.now - (options.maxAgeMs ?? LOW_CONTEXT_MAX_AGE_MS)
  const fresh = messages.find(i => events[i]!.time >= cutoff) ?? messages[messages.length - 1]!
  if (fresh > messages[0]!) keepFrom = Math.max(keepFrom, fresh)
  if (keepFrom <= first) return null
  // Only a summary before it: nothing new to compact.
  if (events.slice(first, keepFrom).every(event => event === undefined || isReplace(event) || event.type === 'system/message')) return null
  return { start: nodes[first]!, end: nodes[keepFrom - 1]! }
}

/** compaction.json's low-context part; off when missing or broken. */
export interface LowContextSettings {
  readonly on: boolean
  readonly keep: number
}

export function parseLowContext(raw: unknown): LowContextSettings {
  const value = (raw ?? {}) as { lowContext?: unknown; keepMessages?: unknown }
  const keep = typeof value.keepMessages === 'number' && Number.isInteger(value.keepMessages)
    ? Math.min(MAX_KEEP_MESSAGES, Math.max(MIN_KEEP_MESSAGES, value.keepMessages))
    : DEFAULT_KEEP_MESSAGES
  return { on: value.lowContext === true, keep }
}

/** Reads the file again only when it changed. */
export function settingsReader(file: string | undefined): () => LowContextSettings {
  let stamp = ''
  let settings: LowContextSettings = parseLowContext(undefined)
  return () => {
    if (file === undefined) return settings
    try {
      const stat = statSync(file)
      const now = `${stat.mtimeMs}:${stat.size}`
      if (now !== stamp) {
        stamp = now
        settings = parseLowContext(JSON.parse(readFileSync(file, 'utf8')))
      }
    } catch {
      stamp = ''
      settings = parseLowContext(undefined)
    }
    return settings
  }
}

interface Engine {
  compactRegion?(start: number, end: number, agent: unknown, signal: AbortSignal): Promise<{ shadowedSeqs: readonly number[] }>
}

interface PreStep {
  readonly agent: { readonly session: SurfaceView & { readonly id: string } }
  readonly signal: AbortSignal
}

export function apply(ctx: Context, config: Config = {}): void {
  const log = ctx.logger('adg-low-context')
  const read = settingsReader(config.file)
  const engine = (ctx as unknown as { compaction: Engine }).compaction
  if (typeof engine?.compactRegion !== 'function') {
    log.warn('this dsh compaction has no compactRegion: low-context mode is off')
    return
  }
  ctx.on('agent/pre-step' as never, (async ({ agent, signal }: PreStep, next: () => Promise<unknown>) => {
    const settings = read()
    if (settings.on && !signal.aborted) {
      try {
        const range = lowContextRange(agent.session, { keep: settings.keep, now: Date.now() })
        if (range !== null) {
          const result = await engine.compactRegion!(range.start, range.end, agent, signal)
          log.info(`low-context: compacted ${result.shadowedSeqs.length} records (seqs ${range.start}-${range.end}) of ${agent.session.id}`)
        }
      } catch (error) {
        log.warn(`low-context compaction of ${agent.session.id} failed: ${error instanceof Error ? error.message : String(error)}; continuing the turn`)
      }
    }
    return next()
  }) as never)
}
