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
 * Mounted in the agent preset's compaction group, next to dsh-compaction-basic
 * (scripts/lib/standard-preset.mjs), so it reaches that group's engine. It
 * reads compaction.json each time (a stat, and the file only when it
 * changed), so turning it on or off applies at once.
 */
import { readFileSync, statSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { LOW_CONTEXT_WINDOW_MS } from '@adg/protocol'

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
 * nothing needs it: everything from after the system prompt up to the first
 * message of the window. It ends just before a message, so a turn (with its
 * tool calls and results) goes whole, and the latest message always stays.
 */
export function lowContextRange(session: SurfaceView, options: { now: number; windowMs?: number }): { start: number; end: number } | null {
  const nodes = session.surface.nodes
  const events = nodes.map(seq => session.eventAt(seq))
  const first = events[0]?.type === 'system/message' ? 1 : 0
  const messages: number[] = []
  for (let i = first; i < events.length; i++) if (events[i] !== undefined && isMessage(events[i]!)) messages.push(i)
  if (messages.length === 0) return null
  const cutoff = options.now - (options.windowMs ?? LOW_CONTEXT_WINDOW_MS)
  // The first message in the window; when every one is older, the latest of them stays.
  const keepFrom = messages.find(i => events[i]!.time >= cutoff) ?? messages[messages.length - 1]!
  if (keepFrom <= first) return null
  // Only a summary before it: nothing new to compact.
  if (events.slice(first, keepFrom).every(event => event === undefined || isReplace(event) || event.type === 'system/message')) return null
  return { start: nodes[first]!, end: nodes[keepFrom - 1]! }
}

/** compaction.json's low-context switch; off when missing or broken. */
export function parseLowContext(raw: unknown): boolean {
  return (raw as { lowContext?: unknown } | undefined)?.lowContext === true
}

/** Reads the file again only when it changed. */
export function settingsReader(file: string | undefined): () => boolean {
  let stamp = ''
  let on = false
  return () => {
    if (file === undefined) return on
    try {
      const stat = statSync(file)
      const now = `${stat.mtimeMs}:${stat.size}`
      if (now !== stamp) {
        stamp = now
        on = parseLowContext(JSON.parse(readFileSync(file, 'utf8')))
      }
    } catch {
      stamp = ''
      on = false
    }
    return on
  }
}

interface Engine {
  compactRegion?(start: number, end: number, agent: unknown, signal: AbortSignal): Promise<{ shadowedSeqs: readonly number[] }>
}

/** The agent ending its turn, as dsh's `agent/turn-stopping` gives it. */
export interface StoppingAgent {
  readonly session: SurfaceView & { readonly id: string }
  readonly inbox?: { readonly nextTurn?: readonly unknown[]; readonly nextStep?: readonly unknown[] }
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
  const enabled = settingsReader(config.file)
  const engine = (ctx as unknown as { compaction: Engine }).compaction
  if (typeof engine?.compactRegion !== 'function') {
    log.warn('this dsh compaction has no compactRegion: low-context mode is off')
    return
  }
  // The turn is still open here, so the compaction belongs to it (as dsh's own automatic one does).
  ctx.on('agent/turn-stopping' as never, (async ({ agent, signal }: { agent: StoppingAgent; signal: AbortSignal }) => {
    if (!enabled() || signal.aborted) return
    try {
      if (!taskOver(agent, (ctx.get as (name: string) => unknown)('adgGateway') as WorkView | undefined)) return
      const range = lowContextRange(agent.session, { now: Date.now() })
      if (range === null) return
      const result = await engine.compactRegion!(range.start, range.end, agent, signal)
      log.info(`low-context: compacted ${result.shadowedSeqs.length} records (seqs ${range.start}-${range.end}) of ${agent.session.id}`)
    } catch (error) {
      log.warn(`low-context compaction of ${agent.session.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)
}
