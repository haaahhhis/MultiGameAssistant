/**
 * Session event DTOs: the stable, UI-facing shape of the dsh session log.
 *
 * The gateway converts upstream `SessionWireEvent`s into these records. Known
 * event types get explicit fields; anything else passes through as an opaque
 * `UnknownEvent` that UIs may ignore. Upstream event changes are absorbed by
 * the gateway converter, never by UI code.
 */
import { z } from 'zod'

/** One block of message content, flattened to what a UI can render. */
export const ContentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    name: z.string().optional(),
    mediaType: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  z.object({
    type: z.literal('file'),
    name: z.string().optional(),
    size: z.number().optional(),
    mediaType: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool-call'),
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  /** A block kind the gateway does not translate (tool additions, future kinds). */
  z.object({ type: z.literal('other'), kind: z.string() }),
])
export type ContentPart = z.infer<typeof ContentPart>

/** Token accounting for one model call; counts are disjoint as upstream defines them. */
export const TokenUsage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsage>

/**
 * Wall-clock facts extracted from one model attempt's timed stream. All values
 * are epoch milliseconds; absent means the stream carried no such chunk.
 */
export const StreamTiming = z.object({
  /** First chunk of any kind. */
  firstChunkAt: z.number().optional(),
  /** First chunk carrying an output token (text, reasoning, or tool-call fragment). */
  firstTokenAt: z.number().optional(),
  /** Last chunk of any kind. */
  lastChunkAt: z.number().optional(),
  /** Number of token-bearing chunks. */
  tokenChunks: z.number(),
})
export type StreamTiming = z.infer<typeof StreamTiming>

/** A provider or tool failure as a UI shows it. */
export const Failure = z.object({
  message: z.string(),
  code: z.string().optional(),
})
export type Failure = z.infer<typeof Failure>

/** Why a turn ended. `kind` is open: unknown kinds keep their raw name. */
export const TurnEndReason = z.object({
  kind: z.string(),
  message: z.string().optional(),
})
export type TurnEndReason = z.infer<typeof TurnEndReason>

/** Where a user-role message came from. */
export const MessageOrigin = z.object({
  /** Upstream source kind: `user`, `user-rpc`, injected-context producers, goal rounds, ... */
  kind: z.string(),
  /** True for a direct human prompt; false for injected context. */
  human: z.boolean(),
  /** One-line account for `notice`-form injected context. */
  summary: z.string().optional(),
})
export type MessageOrigin = z.infer<typeof MessageOrigin>

const base = { seq: z.number(), time: z.number() }

export const SessionEvent = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('turn/start'), turn: z.number() }),
  z.object({ ...base, type: z.literal('turn/end'), turn: z.number(), reason: TurnEndReason }),
  z.object({ ...base, type: z.literal('step/start'), turn: z.number(), step: z.number() }),
  z.object({ ...base, type: z.literal('step/end'), turn: z.number(), step: z.number() }),
  z.object({
    ...base,
    type: z.literal('user/message'),
    messageId: z.string(),
    content: z.array(ContentPart),
    origin: MessageOrigin,
    /** Client correlation id when the prompt came through a request id. */
    requestId: z.string().optional(),
    /** True when this message replaced earlier history (compaction summary). */
    replacesHistory: z.boolean().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('system/message'),
    turn: z.number(),
    step: z.number(),
    text: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('assistant/message'),
    turn: z.number(),
    step: z.number(),
    messageId: z.string(),
    content: z.array(ContentPart),
    timing: StreamTiming,
    usage: TokenUsage.optional(),
    interrupted: z.boolean().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('assistant/attempt'),
    turn: z.number(),
    step: z.number(),
    timing: StreamTiming,
    error: Failure.optional(),
  }),
  z.object({
    ...base,
    type: z.literal('tool/call'),
    turn: z.number(),
    step: z.number(),
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('tool/result'),
    turn: z.number(),
    step: z.number(),
    callId: z.string(),
    isError: z.boolean(),
    content: z.array(ContentPart),
    error: Failure.optional(),
  }),
  z.object({
    ...base,
    type: z.literal('request/header'),
    provider: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    toolNames: z.array(z.string()),
    reason: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('compaction/start'),
    compactionId: z.string(),
    turn: z.number().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('compaction/summary'),
    compactionId: z.string(),
    shadowedTokenCount: z.number(),
    provider: z.string().optional(),
    model: z.string().optional(),
    usage: TokenUsage.optional(),
  }),
  z.object({
    ...base,
    type: z.literal('compaction/end'),
    compactionId: z.string(),
    turn: z.number().nullable(),
    error: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('approval/asked'),
    approvalId: z.string(),
    toolName: z.string(),
    callId: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('approval/decided'),
    approvalId: z.string(),
    outcome: z.string(),
  }),
  z.object({ ...base, type: z.literal('session/title'), title: z.string() }),
  /** Any upstream event the gateway does not translate. */
  z.object({
    ...base,
    type: z.literal('unknown'),
    upstreamType: z.string(),
    data: z.unknown(),
  }),
])
export type SessionEvent = z.infer<typeof SessionEvent>
export type SessionEventType = SessionEvent['type']
export type EventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>

/**
 * Process-local live output for the model attempt currently streaming.
 * Frames of one attempt arrive in order: one `start`, any `delta`s, one `end`.
 * The durable `assistant/message` or `assistant/attempt` event arrives before
 * the attempt's `end` frame.
 */
export const LiveFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    attemptId: z.string(),
    turn: z.number(),
    step: z.number(),
    /** Last durable seq observed when the attempt started. */
    afterSeq: z.number(),
  }),
  z.object({
    type: z.literal('delta'),
    attemptId: z.string(),
    time: z.number(),
    kind: z.enum(['text', 'reasoning', 'tool-args']),
    /** Content block position inside the assistant message. */
    index: z.number(),
    text: z.string(),
    callId: z.string().optional(),
    toolName: z.string().optional(),
  }),
  z.object({
    type: z.literal('end'),
    attemptId: z.string(),
    outcome: z.enum(['committed', 'abandoned']),
    seq: z.number().optional(),
  }),
])
export type LiveFrame = z.infer<typeof LiveFrame>

/** The live attempt as captured when a session is opened mid-stream. */
export const LiveAttempt = z.object({
  attemptId: z.string(),
  turn: z.number(),
  step: z.number(),
  afterSeq: z.number(),
  deltas: z.array(LiveFrame.options[1]),
})
export type LiveAttempt = z.infer<typeof LiveAttempt>
