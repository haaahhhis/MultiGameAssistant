/**
 * Pure projection from protocol events (+ the live attempt) to a
 * {@link TrajectoryModel}. No framework, no I/O: the same function runs in a
 * browser UI, in Node, or inside the gateway for non-JS clients.
 *
 * Semantics follow the upstream Trajectory view:
 * - records group by turn, then by step; work outside a turn forms a
 *   "between turns" group;
 * - TTFT is measured from step start to the first output token, including
 *   output of earlier retried attempts in the same step, and stays unknown when
 *   the step start is outside the loaded window;
 * - running records carry only a start; no duration is invented.
 */
import type { ContentPart, EventOf, Failure, LiveFrame, SessionEvent } from '@adg/protocol'
import type {
  AssistantRecord, AttemptRecord, CompactionRecord, RecordStatus, SystemRecord, ToolRecord,
  TrajectoryGroup, TrajectoryModel, TrajectoryRecord, TrajectoryStep, TrajectoryTotals, UserRecord,
} from './model.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type Delta = Extract<LiveFrame, { type: 'delta' }>

/** The streaming attempt as the client store holds it. */
export interface LiveAttemptView {
  readonly attemptId: string
  readonly turn: number
  readonly step: number
  readonly afterSeq: number
  readonly deltas: readonly Delta[]
}

export interface BuildOptions {
  /** Clock used to bound running records in `span`; defaults to the last known instant. */
  readonly now?: number
}

const PREVIEW_CHARS = 160

/** First non-empty line of `text`, bounded for one-line display. */
export function previewText(text: string, limit = PREVIEW_CHARS): string {
  const line = text.split(/\r?\n/).find(l => l.trim() !== '')?.trim() ?? ''
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function textOf(content: readonly ContentPart[], type: 'text' | 'reasoning' = 'text'): string {
  return content.filter((p): p is Extract<ContentPart, { type: 'text' | 'reasoning' }> => p.type === type)
    .map(p => p.text).join('')
}

function contentPreview(content: readonly ContentPart[]): string {
  const text = previewText(textOf(content))
  if (text !== '') return text
  const reasoning = previewText(textOf(content, 'reasoning'))
  if (reasoning !== '') return reasoning
  const calls = content.filter(p => p.type === 'tool-call').map(p => p.name)
  if (calls.length > 0) return `→ ${calls.join(', ')}`
  const images = content.filter(p => p.type === 'image').length
  const files = content.filter(p => p.type === 'file').length
  return [images > 0 ? `${images} image(s)` : '', files > 0 ? `${files} file(s)` : ''].filter(Boolean).join(' · ')
}

interface StepState {
  turn: number
  step: number
  start: number
  /** Whether the step/start event is inside the loaded window. */
  startKnown: boolean
  end: number | null
  records: TrajectoryRecord[]
  /** Earliest output token over every attempt of the step. */
  firstTokenAt?: number
  retries: number
  lastRetryError?: Failure
  requestIndex?: number
}

interface GroupState {
  key: string
  turn: number | null
  start: number
  end: number | null
  partialStart: boolean
  reason?: TrajectoryGroup['reason']
  steps: Map<number, StepState>
  stepOrder: number[]
  records: TrajectoryRecord[]
}

interface HeaderFacts {
  provider?: string
  model?: string
  reasoningEffort?: string
  toolCount: number
}

/**
 * Build the trajectory for one loaded event window.
 * @param events - protocol events in ascending seq order.
 * @param live - the attempt currently streaming, or null.
 * @param options - clock override.
 * @returns the complete model; inputs are never mutated.
 */
export function buildTrajectory(
  events: readonly SessionEvent[],
  live: LiveAttemptView | null = null,
  options: BuildOptions = {},
): TrajectoryModel {
  const groups: GroupState[] = []
  const turnGroups = new Map<number, GroupState>()
  const records: TrajectoryRecord[] = []
  const tools = new Map<string, Mutable<ToolRecord>>()
  const compactions = new Map<string, Mutable<CompactionRecord>>()
  const approvals = new Map<string, string>()
  let openTurn: GroupState | null = null
  let between: GroupState | null = null
  let header: HeaderFacts | null = null
  let requestCounter = 0
  let lastInstant = 0

  const groupForTurn = (turn: number, time: number): GroupState => {
    let group = turnGroups.get(turn)
    if (group === undefined) {
      // The turn opened before the loaded window.
      group = newGroup(`t:${turn}`, turn, time, true)
      turnGroups.set(turn, group)
      groups.push(group)
    }
    between = null
    return group
  }

  const groupForUnscoped = (time: number, seq: number): GroupState => {
    if (openTurn !== null) return openTurn
    if (between === null) {
      between = newGroup(`b:${seq}`, null, time, false)
      groups.push(between)
    }
    return between
  }

  const stepFor = (group: GroupState, turn: number, step: number, time: number): StepState => {
    let state = group.steps.get(step)
    if (state === undefined) {
      state = { turn, step, start: time, startKnown: false, end: null, records: [], retries: 0 }
      group.steps.set(step, state)
      group.stepOrder.push(step)
    }
    return state
  }

  const push = (group: GroupState, step: StepState | null, record: TrajectoryRecord) => {
    group.records.push(record)
    step?.records.push(record)
    records.push(record)
  }

  const requestIndexFor = (step: StepState): number => {
    step.requestIndex ??= ++requestCounter
    return step.requestIndex
  }

  const committedSteps = new Set<string>()
  for (const event of events) {
    lastInstant = Math.max(lastInstant, event.time)
    switch (event.type) {
      case 'turn/start': {
        const group = newGroup(`t:${event.turn}`, event.turn, event.time, false)
        turnGroups.set(event.turn, group)
        groups.push(group)
        openTurn = group
        between = null
        break
      }
      case 'turn/end': {
        const group = groupForTurn(event.turn, event.time)
        group.end = event.time
        group.reason = event.reason
        for (const step of group.steps.values()) step.end ??= event.time
        for (const tool of tools.values()) {
          if (tool.turn === event.turn && tool.status === 'running') {
            tool.status = 'interrupted'
            tool.end = event.time
          }
        }
        if (openTurn === group) openTurn = null
        break
      }
      case 'step/start': {
        const group = groupForTurn(event.turn, event.time)
        const step = stepFor(group, event.turn, event.step, event.time)
        step.start = event.time
        step.startKnown = true
        break
      }
      case 'step/end': {
        const group = groupForTurn(event.turn, event.time)
        stepFor(group, event.turn, event.step, event.time).end = event.time
        break
      }
      case 'user/message': {
        const group = groupForUnscoped(event.time, event.seq)
        push(group, null, userRecord(event, group.turn))
        break
      }
      case 'system/message': {
        if (event.text.trim() === '') break
        const group = groupForTurn(event.turn, event.time)
        const step = stepFor(group, event.turn, event.step, event.time)
        const record: SystemRecord = {
          kind: 'system', id: `system:${event.seq}`, seq: event.seq, turn: event.turn, step: event.step,
          start: event.time, end: event.time, status: 'ok', title: 'System prompt',
          preview: previewText(event.text), text: event.text,
        }
        push(group, step, record)
        break
      }
      case 'request/header': {
        header = {
          ...(event.provider === undefined ? {} : { provider: event.provider }),
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.reasoningEffort === undefined ? {} : { reasoningEffort: event.reasoningEffort }),
          toolCount: event.toolNames.length,
        }
        break
      }
      case 'assistant/attempt': {
        const group = groupForTurn(event.turn, event.time)
        const step = stepFor(group, event.turn, event.step, event.time)
        noteFirstToken(step, event.timing.firstTokenAt)
        step.retries += 1
        if (event.error !== undefined) step.lastRetryError = event.error
        const record: AttemptRecord = {
          kind: 'attempt', id: `attempt:${event.seq}`, seq: event.seq, turn: event.turn, step: event.step,
          start: event.timing.firstChunkAt ?? step.start, end: event.timing.lastChunkAt ?? event.time,
          status: 'error', title: 'Failed attempt', preview: event.error?.message ?? 'attempt ended without output',
          ...(event.error === undefined ? {} : { error: event.error }),
        }
        push(group, step, record)
        break
      }
      case 'assistant/message': {
        const group = groupForTurn(event.turn, event.time)
        const step = stepFor(group, event.turn, event.step, event.time)
        noteFirstToken(step, event.timing.firstTokenAt)
        committedSteps.add(`${event.turn}:${event.step}`)
        const settledFirst = event.timing.firstTokenAt
        const settledLast = event.timing.lastChunkAt
        const decodeMs = settledFirst !== undefined && settledLast !== undefined ? settledLast - settledFirst : undefined
        const model = event.model ?? header?.model
        const provider = event.provider ?? header?.provider
        const record: AssistantRecord = {
          kind: 'assistant', id: `assistant:${event.seq}`, seq: event.seq, turn: event.turn, step: event.step,
          start: step.start, end: settledLast ?? event.time,
          status: event.interrupted === true ? 'interrupted' : 'ok',
          title: model === undefined ? 'Assistant' : `Assistant · ${model}`,
          preview: contentPreview(event.content),
          content: event.content,
          live: false,
          interrupted: event.interrupted === true,
          request: compact({
            index: requestIndexFor(step),
            provider,
            model,
            reasoningEffort: header?.reasoningEffort,
            toolCount: header?.toolCount,
            ttftMs: ttftOf(step),
            decodeMs,
            tokensPerSecond: throughput(event.usage?.outputTokens, decodeMs),
            usage: event.usage,
            retries: step.retries,
            lastRetryError: step.lastRetryError,
          }),
        }
        push(group, step, record)
        break
      }
      case 'tool/call': {
        const group = groupForTurn(event.turn, event.time)
        const step = stepFor(group, event.turn, event.step, event.time)
        const approvalId = approvals.get(event.callId)
        const record: Mutable<ToolRecord> = {
          kind: 'tool', id: `tool:${event.callId}`, seq: event.seq, turn: event.turn, step: event.step,
          start: event.time, end: null, status: group.end === null ? 'running' : 'interrupted',
          title: event.name, preview: previewText(event.arguments), name: event.name, callId: event.callId,
          arguments: event.arguments, isError: false,
          ...(approvalId === undefined ? {} : { approval: { approvalId } }),
        }
        tools.set(event.callId, record)
        push(group, step, record)
        break
      }
      case 'tool/result': {
        const record = tools.get(event.callId)
        if (record === undefined) {
          // Result whose call is outside the loaded window: show it on its own.
          const group = groupForTurn(event.turn, event.time)
          const step = stepFor(group, event.turn, event.step, event.time)
          const orphan: ToolRecord = {
            kind: 'tool', id: `tool:${event.callId}`, seq: event.seq, turn: event.turn, step: event.step,
            start: event.time, end: event.time, status: event.isError ? 'error' : 'ok',
            title: 'tool result', preview: contentPreview(event.content), name: 'tool result',
            callId: event.callId, arguments: '', result: event.content, isError: event.isError,
            ...(event.error === undefined ? {} : { error: event.error }),
          }
          push(group, step, orphan)
          break
        }
        record.end = event.time
        record.result = event.content
        record.isError = event.isError
        record.status = event.isError ? 'error' : 'ok'
        if (event.error !== undefined) record.error = event.error
        const resultPreview = contentPreview(event.content)
        if (resultPreview !== '') record.preview = `${previewText(record.arguments, 80)}  ⇒  ${resultPreview}`
        break
      }
      case 'approval/asked': {
        if (event.callId === undefined) break
        approvals.set(event.callId, event.approvalId)
        const tool = tools.get(event.callId)
        if (tool !== undefined) {
          tool.approval = { approvalId: event.approvalId, ...(event.reason === undefined ? {} : { reason: event.reason }) }
        }
        break
      }
      case 'approval/decided': {
        for (const tool of tools.values()) {
          if (tool.approval?.approvalId === event.approvalId) tool.approval = { ...tool.approval, outcome: event.outcome }
        }
        break
      }
      case 'compaction/start': {
        const group = event.turn === null ? groupForUnscoped(event.time, event.seq) : groupForTurn(event.turn, event.time)
        const record: Mutable<CompactionRecord> = {
          kind: 'compaction', id: `compaction:${event.compactionId}`, seq: event.seq, turn: group.turn, step: null,
          start: event.time, end: null, status: 'running', title: 'Compaction', preview: 'summarizing history…',
          compactionId: event.compactionId,
        }
        compactions.set(event.compactionId, record)
        push(group, null, record)
        break
      }
      case 'compaction/summary': {
        const record = compactions.get(event.compactionId)
        if (record === undefined) break
        record.shadowedTokenCount = event.shadowedTokenCount
        if (event.usage !== undefined) record.usage = event.usage
        record.preview = `${event.shadowedTokenCount.toLocaleString('en-US')} tokens summarized`
        break
      }
      case 'compaction/end': {
        const record = compactions.get(event.compactionId)
        if (record === undefined) break
        record.end = event.time
        record.status = event.error === undefined ? 'ok' : 'error'
        if (event.error !== undefined) {
          record.error = event.error
          record.preview = event.error
        }
        break
      }
      default:
        break
    }
  }

  if (live !== null && !committedSteps.has(`${live.turn}:${live.step}`)) {
    const group = groupForTurn(live.turn, live.deltas[0]?.time ?? options.now ?? lastInstant)
    const step = stepFor(group, live.turn, live.step, live.deltas[0]?.time ?? options.now ?? lastInstant)
    const firstToken = live.deltas.find(d => d.text !== '' || d.toolName !== undefined)?.time
    noteFirstToken(step, firstToken)
    const content = liveContent(live.deltas)
    const lastDelta = live.deltas.at(-1)?.time
    if (lastDelta !== undefined) lastInstant = Math.max(lastInstant, lastDelta)
    const record: AssistantRecord = {
      kind: 'assistant', id: `live:${live.attemptId}`, seq: live.afterSeq, turn: live.turn, step: live.step,
      start: step.start, end: null, status: 'running',
      title: header?.model === undefined ? 'Assistant' : `Assistant · ${header.model}`,
      preview: contentPreview(content) || 'waiting for output…',
      content, live: true, interrupted: false,
      request: compact({
        index: requestIndexFor(step),
        provider: header?.provider,
        model: header?.model,
        reasoningEffort: header?.reasoningEffort,
        toolCount: header?.toolCount,
        ttftMs: ttftOf(step),
        retries: step.retries,
        lastRetryError: step.lastRetryError,
      }),
    }
    push(group, step, record)
  }

  const frozen: TrajectoryGroup[] = groups.map(group => ({
    key: group.key,
    turn: group.turn,
    start: group.start,
    end: group.end,
    partialStart: group.partialStart,
    ...(group.reason === undefined ? {} : { reason: group.reason }),
    steps: group.stepOrder.map((n): TrajectoryStep => {
      const s = group.steps.get(n) as StepState
      return { turn: s.turn, step: s.step, start: s.start, end: s.end, records: s.records }
    }),
    records: group.records,
  }))

  const now = options.now ?? lastInstant
  return { groups: frozen, records, totals: totalsOf(records), span: spanOf(records, now) }
}

function newGroup(key: string, turn: number | null, start: number, partialStart: boolean): GroupState {
  return { key, turn, start, end: null, partialStart, steps: new Map(), stepOrder: [], records: [] }
}

function userRecord(event: EventOf<'user/message'>, turn: number | null): UserRecord {
  const human = event.origin.human
  const kind = human ? 'user' : 'context'
  const imageCount = event.content.filter(p => p.type === 'image').length
  const fileCount = event.content.filter(p => p.type === 'file').length
  const title = human
    ? 'User'
    : event.replacesHistory === true ? 'Compacted history' : `Context · ${event.origin.kind}`
  return {
    kind, id: `user:${event.seq}`, seq: event.seq, turn, step: null,
    start: event.time, end: event.time, status: 'ok', title,
    preview: event.origin.summary ?? contentPreview(event.content),
    content: event.content, origin: event.origin, imageCount, fileCount,
  }
}

function noteFirstToken(step: StepState, at: number | undefined): void {
  if (at === undefined) return
  if (step.firstTokenAt === undefined || at < step.firstTokenAt) step.firstTokenAt = at
}

function ttftOf(step: StepState): number | undefined {
  // A step start outside the loaded window leaves TTFT unavailable.
  if (!step.startKnown || step.firstTokenAt === undefined) return undefined
  const ttft = step.firstTokenAt - step.start
  return ttft >= 0 ? ttft : undefined
}

function throughput(outputTokens: number | undefined, decodeMs: number | undefined): number | undefined {
  if (outputTokens === undefined || decodeMs === undefined || decodeMs <= 0) return undefined
  return outputTokens / (decodeMs / 1000)
}

function liveContent(deltas: readonly Delta[]): ContentPart[] {
  const blocks = new Map<number, ContentPart>()
  for (const d of deltas) {
    const current = blocks.get(d.index)
    if (d.kind === 'tool-args') {
      const prev = current?.type === 'tool-call' ? current : undefined
      blocks.set(d.index, {
        type: 'tool-call',
        callId: d.callId ?? prev?.callId ?? '',
        name: d.toolName ?? prev?.name ?? '',
        arguments: (prev?.arguments ?? '') + d.text,
      })
    } else {
      const type = d.kind === 'text' ? 'text' : 'reasoning'
      const prev = current?.type === type ? current.text : ''
      blocks.set(d.index, { type, text: prev + d.text })
    }
  }
  return [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part)
}

function totalsOf(records: readonly TrajectoryRecord[]): TrajectoryTotals {
  const totals = {
    requests: 0, toolCalls: 0, errors: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  }
  for (const record of records) {
    if (record.status === 'error') totals.errors += 1
    if (record.kind === 'tool') totals.toolCalls += 1
    const usage = record.kind === 'assistant' ? record.request.usage : record.kind === 'compaction' ? record.usage : undefined
    if (record.kind === 'assistant') totals.requests += 1
    if (usage === undefined) continue
    totals.inputTokens += usage.inputTokens
    totals.outputTokens += usage.outputTokens
    totals.cacheReadTokens += usage.cacheReadTokens ?? 0
    totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    totals.reasoningTokens += usage.reasoningTokens ?? 0
  }
  return totals
}

function spanOf(records: readonly TrajectoryRecord[], now: number): TrajectoryModel['span'] {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const record of records) {
    start = Math.min(start, record.start)
    end = Math.max(end, record.end ?? Math.max(record.start, now))
  }
  return Number.isFinite(start) ? { start, end: Math.max(start, end) } : null
}

/** Drop undefined-valued keys so optional properties stay absent. */
function compact<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never
}

export type { RecordStatus }
