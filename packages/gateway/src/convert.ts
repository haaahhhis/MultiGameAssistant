/**
 * Anti-corruption layer: upstream dsh session wire records → protocol DTOs.
 *
 * Upstream payloads are read as untyped JSON on purpose. This file is the one
 * place that knows upstream field names; when an upstream release renames or
 * reshapes an event, only these functions change. Anything not recognized
 * passes through as an `unknown` DTO so UIs can still list it.
 */
import type { ContentPart, Failure, LiveAttempt, LiveFrame, SessionEvent, StreamTiming, TokenUsage } from '@adg/protocol'

/** The subset of upstream `SessionWireEvent` the converter reads. */
export interface WireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: unknown
}

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])

/** Assign only defined values so optional DTO fields stay absent. */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

export function convertContent(blocks: unknown): ContentPart[] {
  return arr(blocks).map((block): ContentPart => {
    if (!isObj(block)) return { type: 'other', kind: typeof block }
    switch (block.type) {
      case 'text':
        return { type: 'text', text: str(block.text) ?? '' }
      case 'reasoning':
        return { type: 'reasoning', text: str(block.text) ?? '' }
      case 'image': {
        const a = isObj(block.attachment) ? block.attachment : {}
        return {
          type: 'image',
          ...opt('name', str(a.name)),
          ...opt('mediaType', str(a.mediaType)),
          ...opt('width', num(a.width)),
          ...opt('height', num(a.height)),
          ...opt('attachmentId', str(a.attachmentId)),
          ...opt('bytes', num(a.bytes)),
        }
      }
      case 'file': {
        const a = isObj(block.attachment) ? block.attachment : {}
        return { type: 'file', ...opt('name', str(a.name)), ...opt('size', num(a.bytes)), ...opt('mediaType', str(a.mediaType)) }
      }
      case 'tool-call':
        return {
          type: 'tool-call',
          callId: str(block.id) ?? '',
          name: str(block.name) ?? '',
          arguments: str(block.arguments) ?? '',
        }
      default:
        return { type: 'other', kind: str(block.type) ?? 'unknown' }
    }
  })
}

export function convertUsage(value: unknown): TokenUsage | undefined {
  if (!isObj(value)) return undefined
  const input = num(value.inputTokens)
  const output = num(value.outputTokens)
  if (input === undefined || output === undefined) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...opt('totalTokens', num(value.totalTokens)),
    ...opt('cacheReadTokens', num(value.cacheReadTokens)),
    ...opt('cacheWriteTokens', num(value.cacheWriteTokens)),
    ...opt('reasoningTokens', num(value.reasoningTokens)),
  }
}

function convertFailure(value: unknown): Failure | undefined {
  if (!isObj(value)) return undefined
  const message = str(value.message)
  if (message === undefined) return undefined
  return { message, ...opt('code', str(value.code)) }
}

/**
 * Read timing facts out of one compact upstream assistant stream.
 *
 * Packed runs (`text-chunks`, `reasoning-chunks`, `tool-call-chunks`) carry
 * `time0` plus per-member gaps `dt`; raw `chunk` records carry `time`. Only
 * non-empty deltas (or name-bearing tool-call deltas) count as tokens.
 */
export function streamFacts(stream: unknown): { timing: StreamTiming; failure?: Failure } {
  let firstChunkAt: number | undefined
  let firstTokenAt: number | undefined
  let lastChunkAt: number | undefined
  let tokenChunks = 0
  let failure: Failure | undefined
  const see = (time: number, token: boolean) => {
    firstChunkAt ??= time
    lastChunkAt = time
    if (token) {
      firstTokenAt ??= time
      tokenChunks += 1
    }
  }
  for (const record of arr(stream)) {
    if (!isObj(record)) continue
    if (record.type === 'chunk') {
      const time = num(record.time)
      if (time === undefined) continue
      see(time, false)
      const chunk = isObj(record.chunk) ? record.chunk : {}
      if (chunk.type === 'finish' && isObj(chunk.reason)) {
        const kind = chunk.reason.kind
        if (kind === 'error' || kind === 'aborted') failure = convertFailure(chunk.reason.failure) ?? { message: String(kind) }
      }
      continue
    }
    const time0 = num(record.time0)
    if (time0 === undefined) continue
    const members = record.type === 'tool-call-chunks' ? arr(record.args) : arr(record.texts)
    const gaps = arr(record.dt)
    const named = record.type === 'tool-call-chunks' && str(record.name) !== undefined
    let time = time0
    members.forEach((member, i) => {
      if (i > 0) time += num(gaps[i - 1]) ?? 0
      see(time, (typeof member === 'string' && member !== '') || named)
    })
  }
  return {
    timing: {
      tokenChunks,
      ...opt('firstChunkAt', firstChunkAt),
      ...opt('firstTokenAt', firstTokenAt),
      ...opt('lastChunkAt', lastChunkAt),
    },
    ...(failure === undefined ? {} : { failure }),
  }
}

const HUMAN_SOURCES = new Set(['user', 'user-rpc'])

/**
 * Convert one upstream session wire event.
 * @param event - a durable record from a follow snapshot, live entry, or history page.
 * @returns the protocol DTO; unrecognized types become `unknown`.
 */
export function convertEvent(event: WireEvent): SessionEvent {
  const { seq, time } = event
  const d = isObj(event.data) ? event.data : {}
  const turn = num(d.turn)
  const step = num(d.step)
  const unknown = (): SessionEvent => ({ type: 'unknown', seq, time, upstreamType: event.type, data: event.data })

  switch (event.type) {
    case 'turn/start':
      return turn === undefined ? unknown() : { type: 'turn/start', seq, time, turn }
    case 'turn/end': {
      if (turn === undefined) return unknown()
      const reason = isObj(d.reason) ? d.reason : {}
      const failure = convertFailure(reason.error)
      const cause = isObj(reason.reason) ? str(reason.reason.kind) : undefined
      return {
        type: 'turn/end', seq, time, turn,
        reason: { kind: str(reason.kind) ?? 'unknown', ...opt('message', failure?.message ?? cause) },
      }
    }
    case 'step/start':
    case 'step/end':
      return turn === undefined || step === undefined ? unknown() : { type: event.type, seq, time, turn, step }
    case 'user/message': {
      const source = isObj(d.source) ? d.source : {}
      const kind = str(source.kind) ?? 'unknown'
      const replaces = isObj(event.surfaceOp) && event.surfaceOp.op === 'replace'
      return {
        type: 'user/message', seq, time,
        messageId: str(d.id) ?? `seq-${seq}`,
        content: convertContent(d.content),
        origin: {
          kind,
          human: HUMAN_SOURCES.has(kind),
          ...opt('summary', source.form === 'notice' ? str(source.summary) : undefined),
        },
        ...opt('requestId', str(source.rpcId)),
        ...(replaces ? { replacesHistory: true } : {}),
      }
    }
    case 'system/message': {
      if (turn === undefined || step === undefined) return unknown()
      const message = isObj(d.message) ? d.message : {}
      const text = convertContent(message.content).map(p => (p.type === 'text' ? p.text : '')).join('')
      return { type: 'system/message', seq, time, turn, step, text }
    }
    case 'assistant/message': {
      if (turn === undefined || step === undefined) return unknown()
      const message = isObj(d.message) ? d.message : {}
      const source = isObj(message.source) ? message.source : {}
      const usage = convertUsage(d.usage)
      return {
        type: 'assistant/message', seq, time, turn, step,
        messageId: str(message.id) ?? `seq-${seq}`,
        content: convertContent(message.content),
        timing: streamFacts(d.stream).timing,
        ...opt('usage', usage),
        ...(d.interrupted === true ? { interrupted: true } : {}),
        ...opt('provider', str(source.provider)),
        ...opt('model', str(source.model)),
      }
    }
    case 'assistant/attempt': {
      if (turn === undefined || step === undefined) return unknown()
      const facts = streamFacts(d.stream)
      return { type: 'assistant/attempt', seq, time, turn, step, timing: facts.timing, ...opt('error', facts.failure) }
    }
    case 'tool/call':
      if (turn === undefined || step === undefined) return unknown()
      return {
        type: 'tool/call', seq, time, turn, step,
        callId: str(d.callId) ?? '',
        name: str(d.name) ?? '',
        arguments: str(d.arguments) ?? '',
      }
    case 'tool/result': {
      if (turn === undefined || step === undefined) return unknown()
      const message = isObj(d.message) ? d.message : {}
      const error = isObj(d.error)
        ? { message: str(d.error.reason) ?? str(d.error.name) ?? 'tool failed', ...opt('code', str(d.error.code)) }
        : undefined
      return {
        type: 'tool/result', seq, time, turn, step,
        callId: str(message.toolCallId) ?? '',
        isError: message.isError === true,
        content: convertContent(message.content),
        ...opt('error', error),
      }
    }
    case 'request/header': {
      const header = isObj(d.header) ? d.header : {}
      const config = isObj(header.config) ? header.config : {}
      return {
        type: 'request/header', seq, time,
        ...opt('provider', str(config.provider)),
        ...opt('model', str(config.model)),
        ...opt('reasoningEffort', str(config.reasoningEffort)),
        toolNames: arr(header.tools).map(t => (isObj(t) ? str(t.name) : undefined)).filter((n): n is string => n !== undefined),
        reason: str(d.reason) ?? 'unknown',
      }
    }
    case 'compaction/start':
    case 'compaction/end': {
      const compactionId = str(d.compactionId)
      if (compactionId === undefined) return unknown()
      const turnOrNull = num(d.turn) ?? null
      return event.type === 'compaction/start'
        ? { type: 'compaction/start', seq, time, compactionId, turn: turnOrNull }
        : { type: 'compaction/end', seq, time, compactionId, turn: turnOrNull, ...opt('error', str(d.error)) }
    }
    case 'compaction/summary': {
      const compactionId = str(d.compactionId)
      if (compactionId === undefined) return unknown()
      return {
        type: 'compaction/summary', seq, time, compactionId,
        shadowedTokenCount: num(d.shadowedTokenCount) ?? 0,
        ...opt('provider', str(d.provider)),
        ...opt('model', str(d.model)),
        ...opt('usage', convertUsage(d.usage)),
      }
    }
    case 'approval/asked': {
      const approvalId = str(d.id)
      if (approvalId === undefined) return unknown()
      return {
        type: 'approval/asked', seq, time, approvalId,
        toolName: str(d.toolName) ?? '',
        ...opt('callId', str(d.callId)),
        ...opt('reason', str(d.reason)),
      }
    }
    case 'approval/decided': {
      const approvalId = str(d.id)
      if (approvalId === undefined) return unknown()
      return { type: 'approval/decided', seq, time, approvalId, outcome: str(d.outcome) ?? 'unknown' }
    }
    case 'session/title': {
      const title = str(d.title)
      return title === undefined ? unknown() : { type: 'session/title', seq, time, title }
    }
    default:
      return unknown()
  }
}

/**
 * Convert one `{ type: 'event', event }` journal record.
 * @returns the DTO, or null for non-event records.
 */
export function convertRecord(record: unknown): SessionEvent | null {
  return isObj(record) && record.type === 'event' && isObj(record.event)
    ? convertEvent(record.event as unknown as WireEvent)
    : null
}

/** Convert the records of a follow snapshot or history page, keeping only event records. */
export function convertRecords(records: readonly unknown[]): SessionEvent[] {
  return records.map(convertRecord).filter((e): e is SessionEvent => e !== null)
}

/**
 * Convert one upstream live assistant stream frame.
 * @returns a frame, or null for chunks with no UI meaning (block markers, usage, finish).
 */
export function convertLiveFrame(frame: unknown): LiveFrame | null {
  if (!isObj(frame)) return null
  const attemptId = str(frame.attemptId)
  if (attemptId === undefined) return null
  switch (frame.type) {
    case 'start':
      return {
        type: 'start', attemptId,
        turn: num(frame.turn) ?? 0,
        step: num(frame.step) ?? 0,
        afterSeq: num(frame.startedAfterSeq) ?? -1,
      }
    case 'chunk':
      return liveDelta(attemptId, num(frame.time) ?? Date.now(), frame.chunk)
    case 'end': {
      const outcome = isObj(frame.outcome) ? frame.outcome : {}
      return outcome.kind === 'committed'
        ? { type: 'end', attemptId, outcome: 'committed', ...opt('seq', num(outcome.seq)) }
        : { type: 'end', attemptId, outcome: 'abandoned' }
    }
    default:
      return null
  }
}

function liveDelta(attemptId: string, time: number, chunk: unknown): Extract<LiveFrame, { type: 'delta' }> | null {
  if (!isObj(chunk)) return null
  const index = num(chunk.index) ?? 0
  switch (chunk.type) {
    case 'text-delta':
      return { type: 'delta', attemptId, time, kind: 'text', index, text: str(chunk.text) ?? '' }
    case 'reasoning-delta':
      return { type: 'delta', attemptId, time, kind: 'reasoning', index, text: str(chunk.text) ?? '' }
    case 'tool-call-delta':
      return {
        type: 'delta', attemptId, time, kind: 'tool-args', index,
        text: str(chunk.argumentsDelta) ?? '',
        ...opt('callId', str(chunk.id)),
        ...opt('toolName', str(chunk.name)),
      }
    default:
      return null
  }
}

/**
 * Expand the active attempt captured in a follow snapshot into live deltas.
 * The compact stream uses the same record format as durable assistant events.
 */
export function convertLiveBaseline(baseline: unknown): LiveAttempt | null {
  if (!isObj(baseline) || !isObj(baseline.activeAttempt)) return null
  const active = baseline.activeAttempt
  const attemptId = str(active.attemptId)
  if (attemptId === undefined) return null
  const deltas: Extract<LiveFrame, { type: 'delta' }>[] = []
  for (const record of arr(active.stream)) {
    if (!isObj(record)) continue
    if (record.type === 'chunk') {
      const delta = liveDelta(attemptId, num(record.time) ?? 0, record.chunk)
      if (delta !== null) deltas.push(delta)
      continue
    }
    const time0 = num(record.time0)
    if (time0 === undefined) continue
    const index = num(record.index) ?? 0
    const gaps = arr(record.dt)
    const members = record.type === 'tool-call-chunks' ? arr(record.args) : arr(record.texts)
    let time = time0
    members.forEach((member, i) => {
      if (i > 0) time += num(gaps[i - 1]) ?? 0
      const text = typeof member === 'string' ? member : ''
      if (record.type === 'tool-call-chunks') {
        deltas.push({
          type: 'delta', attemptId, time, kind: 'tool-args', index, text,
          ...opt('callId', str(record.id)),
          ...opt('toolName', str(record.name)),
        })
      } else {
        deltas.push({ type: 'delta', attemptId, time, kind: record.type === 'text-chunks' ? 'text' : 'reasoning', index, text })
      }
    })
  }
  return {
    attemptId,
    turn: num(active.turn) ?? 0,
    step: num(active.step) ?? 0,
    afterSeq: num(active.startedAfterSeq) ?? -1,
    deltas,
  }
}
